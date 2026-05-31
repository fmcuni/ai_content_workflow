/**
 * Gap-analysis agent — TypeScript port of `content_tool/agents/gap_analysis.py`.
 *
 * Refresh-mode entry node: given a run's topic/keywords/existing article, Gemini
 * (grounded by googleSearch + urlContext) produces a structured gap analysis and
 * picks a refresh route. The result is persisted to `content_tool.gap_analyses`
 * and the chosen route is backfilled onto `content_tool.runs`.
 */

import type { Sql } from "postgres";
import { toJsonb } from "../db/serialize";
import { getAssembled, substitute } from "../prompts/store";
import type { GeminiClient, ThoughtCallback } from "../gemini/types";
import { GAP_ANALYSIS_SCHEMA, type GapAnalysis } from "./schemas";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface GapAnalysisInput {
  runId: string;
  topic: string;
  keywords: string[];
  articleUrl: string;
  acfAdvId: number;
  acfWidgetId: number;
  mode: "auto" | "small_refresh" | "full_rewrite";
  editNote?: string | null;
  todayDate: string; // YYYY-MM-DD
  /** Gemini model id — written to the gap_analyses row (NOT NULL column). */
  model: string;
  /** Gemini thinking level — written to the gap_analyses row (NOT NULL column). */
  thinkingLevel: string;
  onThought?: ThoughtCallback;
}

// ---------------------------------------------------------------------------
// Token usage result
// ---------------------------------------------------------------------------

export interface GapAnalysisTokens {
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// System prompt assembly — mirrors Python `build_system_prompt`.
//
// Fetch the assembled "gap_analysis" template and substitute {today_date}.
// ---------------------------------------------------------------------------

async function buildSystemPrompt(sql: Sql, todayDate: string): Promise<string> {
  const template = await getAssembled(sql, "gap_analysis");
  return substitute(template, { today_date: todayDate });
}

// ---------------------------------------------------------------------------
// User prompt — mirrors Python `build_user_prompt` exactly.
// ---------------------------------------------------------------------------

export function buildUserPrompt(opts: {
  topic: string;
  keywords: string[];
  articleUrl: string;
  acfAdvId: number;
  acfWidgetId: number;
  mode: "auto" | "small_refresh" | "full_rewrite";
  editNote?: string | null;
}): string {
  const routeLabel =
    opts.mode === "auto"
      ? "Auto (follow existing logic)"
      : `${opts.mode} (override existing logic)`;
  const en = opts.editNote ? opts.editNote : "N/A";
  const keywordsJoined = opts.keywords.join(", ");
  return (
    `topic: ${opts.topic}\n` +
    `focus_keywords: ${keywordsJoined}\n` +
    `existing_article: ${opts.articleUrl}\n` +
    `acf_adv_id: ${opts.acfAdvId}\n` +
    `acf_widget_id: ${opts.acfWidgetId}\n` +
    `route: ${routeLabel}\n` +
    `article_edit_note: ${en}`
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the gap-analysis agent for a single refresh run.
 *
 * Assembles the system + user prompt, calls Gemini with structured output and
 * the googleSearch + urlContext tools, applies any manual route override, then
 * upserts the result into `content_tool.gap_analyses` and backfills
 * `runs.chosen_route`.
 */
export async function runGapAnalysis(
  sql: Sql,
  gemini: GeminiClient,
  input: GapAnalysisInput,
): Promise<{ gapAnalysis: GapAnalysis; tokens: GapAnalysisTokens }> {
  const systemPrompt = await buildSystemPrompt(sql, input.todayDate);
  const userPrompt = buildUserPrompt({
    topic: input.topic,
    keywords: input.keywords,
    articleUrl: input.articleUrl,
    acfAdvId: input.acfAdvId,
    acfWidgetId: input.acfWidgetId,
    mode: input.mode,
    editNote: input.editNote,
  });

  const result = await gemini.generate({
    agent: "gap_analysis",
    systemPrompt,
    userPrompt,
    responseSchema: GAP_ANALYSIS_SCHEMA as Record<string, unknown>,
    tools: ["googleSearch", "urlContext"],
    onThought: input.onThought,
  });

  // Cast the parsed response — Gemini returns a plain object matching
  // GapAnalysis's shape when responseSchema is provided. Route through
  // `unknown` since `GeminiResult.parsed` is `Record<string, unknown>`.
  let gapAnalysis = result.parsed as unknown as GapAnalysis;

  // Apply the manual override: when the run pinned a route, force it.
  if (input.mode !== "auto") {
    gapAnalysis = { ...gapAnalysis, chosen_route: input.mode };
  }

  // UPSERT into content_tool.gap_analyses. The PK is run_id (no DB default —
  // it is the caller-supplied run id). On conflict (node restart) refresh the
  // payload + token columns. `model` / `thinking_level` are NOT NULL columns.
  //
  // `toJsonb(sql, ...)` sends a NATIVE jsonb param so the column stores a jsonb
  // OBJECT — not a double-encoded string scalar.
  await sql`
    INSERT INTO content_tool.gap_analyses (
      run_id, model, thinking_level, payload,
      tokens_in, tokens_out, thinking_tokens, latency_ms, raw_response
    ) VALUES (
      ${input.runId}::uuid,
      ${input.model},
      ${input.thinkingLevel},
      ${toJsonb(sql, gapAnalysis)},
      ${result.tokensIn},
      ${result.tokensOut},
      ${result.thinkingTokens},
      ${result.latencyMs},
      ${null}
    )
    ON CONFLICT (run_id) DO UPDATE SET
      model = ${input.model},
      thinking_level = ${input.thinkingLevel},
      payload = ${toJsonb(sql, gapAnalysis)},
      tokens_in = ${result.tokensIn},
      tokens_out = ${result.tokensOut},
      thinking_tokens = ${result.thinkingTokens},
      latency_ms = ${result.latencyMs}
  `;

  await sql`
    UPDATE content_tool.runs
       SET chosen_route = ${gapAnalysis.chosen_route}
     WHERE run_id = ${input.runId}::uuid
  `;

  return {
    gapAnalysis,
    tokens: {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      thinkingTokens: result.thinkingTokens,
      latencyMs: result.latencyMs,
    },
  };
}
