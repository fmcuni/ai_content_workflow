/**
 * Outline agent — TypeScript port of `content_tool/agents/outline.py`.
 *
 * Supports both "create" and "refresh" start modes. The create-mode path is
 * the primary focus; the refresh-mode path is also ported for completeness.
 */

import type { Sql } from "postgres";
import { toJsonb } from "../db/serialize";
import { getAssembled, substitute } from "../prompts/store";
import { loadPersona } from "./persona";
import type { GeminiClient, ThoughtCallback } from "../gemini/types";
import { OUTLINE_SCHEMA, type Outline } from "./schemas";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface OutlineInput {
  runId: string;
  startMode: "create" | "refresh";
  /** The run's voice (persona slug); resolves the prompt template under it. */
  voiceSlug: string;
  topic: string;
  keywords: string[];
  targetAudience?: string | null;
  acfAdvId: number;
  acfWidgetId: number;
  editNote?: string | null;
  todayDate: string; // YYYY-MM-DD
  /** Refresh mode: gap-analysis JSON payload */
  gapAnalysisPayload?: object | null;
  /** Refresh mode: fetched article markdown */
  existingMarkdown?: string | null;
  /** Refresh mode: chosen route string */
  chosenRoute?: string | null;
  onThought?: ThoughtCallback;
}

// ---------------------------------------------------------------------------
// Token usage result
// ---------------------------------------------------------------------------

export interface OutlineTokens {
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// System prompt assembly — mirrors Python `build_system_prompt`
//
// For "create": fetch outline_create_mode, rstrip, slot into {create_mode_block}.
// For "refresh": replace {create_mode_block} with "".
// Then substitute {today_date} with todayDate.
// ---------------------------------------------------------------------------

async function buildSystemPrompt(
  sql: Sql,
  startMode: "create" | "refresh",
  todayDate: string,
  voiceSlug: string,
): Promise<string> {
  const block =
    startMode === "create"
      ? (await getAssembled(sql, "outline_create_mode", voiceSlug)).replace(/\n+$/, "")
      : "";

  const template = await getAssembled(sql, "outline_rewrite_mode", voiceSlug);

  // Inject the create-mode block FIRST, then interpolate locale/brand tokens
  // (mirror outline.py / writer.ts). String.replace is first-match-only in JS
  // but these tokens recur, so use replaceAll. HK-ZH defaults equal the old
  // literals → byte-identical for bowtie-editor.
  const { locale: loc } = await loadPersona(sql, voiceSlug);
  return substitute(template, {
    today_date: todayDate,
    create_mode_block: block,
  })
    .replaceAll("{brand_name}", loc.brandName)
    .replaceAll("{output_language}", loc.outputLanguage)
    .replaceAll("{market}", loc.market);
}

// ---------------------------------------------------------------------------
// User prompt — create mode
//
// Mirrors Python `build_user_prompt_create_mode` exactly.
// Full-width colons are intentional — the prompts use CJK style throughout.
// ---------------------------------------------------------------------------

export function buildUserPromptCreateMode(opts: {
  topic: string;
  keywords: string[];
  targetAudience: string | null | undefined;
  acfAdvId: number;
  acfWidgetId: number;
  editNote?: string | null;
}): string {
  const kw = opts.keywords.length > 0 ? opts.keywords.join(", ") : "(無)";
  const audience = opts.targetAudience ?? "(未指定)";
  const noteBlock = opts.editNote ? `編輯指示（最優先）：${opts.editNote}\n` : "";

  return (
    `主題：${opts.topic}\n` +
    `關鍵字：${kw}\n` +
    `目標讀者：${audience}\n` +
    `acf_adv_id: ${opts.acfAdvId}\n` +
    `acf_widget_id: ${opts.acfWidgetId}\n` +
    noteBlock
  );
}

// ---------------------------------------------------------------------------
// User prompt — refresh mode
//
// Mirrors Python `build_user_prompt`.
// ---------------------------------------------------------------------------

export function buildUserPromptRefresh(opts: {
  gapAnalysisPayload: object;
  existingMarkdown: string;
  chosenRoute: string;
  acfAdvId: number;
  acfWidgetId: number;
}): string {
  return (
    `chosen_route: ${opts.chosenRoute}\n` +
    `acf_adv_id: ${opts.acfAdvId}\n` +
    `acf_widget_id: ${opts.acfWidgetId}\n\n` +
    `# gap_analysis\n${JSON.stringify(opts.gapAnalysisPayload)}\n\n` +
    `# existing_article_markdown\n${opts.existingMarkdown}`
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the outline agent for a single run.
 *
 * Assembles the system + user prompt, calls Gemini with structured output,
 * and upserts the result into `content_tool.outlines` — preserving any prior
 * human edits (edited_by_human / human_edits columns are never overwritten).
 */
export async function runOutline(
  sql: Sql,
  gemini: GeminiClient,
  input: OutlineInput,
): Promise<{ outline: Outline; tokens: OutlineTokens }> {
  const systemPrompt = await buildSystemPrompt(
    sql,
    input.startMode,
    input.todayDate,
    input.voiceSlug,
  );

  let userPrompt: string;
  if (input.startMode === "create") {
    userPrompt = buildUserPromptCreateMode({
      topic: input.topic,
      keywords: input.keywords,
      targetAudience: input.targetAudience,
      acfAdvId: input.acfAdvId,
      acfWidgetId: input.acfWidgetId,
      editNote: input.editNote,
    });
  } else {
    userPrompt = buildUserPromptRefresh({
      gapAnalysisPayload: input.gapAnalysisPayload ?? {},
      existingMarkdown: input.existingMarkdown ?? "",
      chosenRoute: input.chosenRoute ?? "small_refresh",
      acfAdvId: input.acfAdvId,
      acfWidgetId: input.acfWidgetId,
    });
  }

  const result = await gemini.generate({
    agent: "outline",
    systemPrompt,
    userPrompt,
    responseSchema: OUTLINE_SCHEMA as Record<string, unknown>,
    tools: [],
    onThought: input.onThought,
  });

  // Cast the parsed response — Gemini returns a plain object matching Outline's
  // shape when responseSchema is provided. Route through `unknown` to satisfy
  // the compiler since `GeminiResult.parsed` is `Record<string, unknown>`.
  const outline = result.parsed as unknown as Outline;

  // UPSERT into content_tool.outlines.
  // On conflict (run_id already exists — e.g. node restart), update only the
  // payload column. edited_by_human and human_edits are left untouched so that
  // any prior human review is not clobbered.
  //
  // `sql.json(...)` sends a NATIVE jsonb param (type OID 3802, serialized once)
  // so the column stores a jsonb OBJECT — not a double-encoded string scalar.
  await sql`
    INSERT INTO content_tool.outlines (run_id, payload, edited_by_human)
    VALUES (${input.runId}, ${toJsonb(sql, outline)}, ${false})
    ON CONFLICT (run_id) DO UPDATE
      SET payload = excluded.payload
  `;

  return {
    outline,
    tokens: {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      thinkingTokens: result.thinkingTokens,
      latencyMs: result.latencyMs,
    },
  };
}
