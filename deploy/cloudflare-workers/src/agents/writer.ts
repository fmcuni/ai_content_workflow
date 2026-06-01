// WRITER node — TypeScript port of content_tool/agents/writer.py for Cloudflare
// Workers. Assembles the writer system + user prompts, calls Gemini with the
// googleSearch + urlContext tools, enforces the markup structural rules with a
// single corrective retry, and upserts the draft into content_tool.drafts.
//
// Prompt strings (the structural-correction block) are reproduced byte-for-byte
// from the Python source so Gemini receives identical input across runtimes.

import type { Sql } from "postgres";
import { toJsonb } from "../db/serialize";
import type { GeminiClient, ThoughtCallback } from "../gemini/types";
import { getAssembled } from "../prompts/store";
import { loadPersona, toPromptBlock } from "./persona";
import { SourcePolicy } from "../config/source_policy";
import {
  WRITER_OUTPUT_SCHEMA,
  type WriterOutput,
  type CitationIntent,
} from "./schemas";

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

/** The run fields the writer reads (subset of content_tool.runs). */
export interface WriterRunInput {
  runId: string;
  topic: string;
  keywords: string[];
  articleUrl: string | null;
  acfAdvId: string | null;
  acfWidgetId: string | null;
  topicCategory: string | null;
  persona: string;
  startMode: string;
  chosenRoute: string | null;
  editNote: string | null;
}

/**
 * A single refine note injected into the user prompt on iteration > 0. The
 * Workflow builds this list from the prior audit's high/must_fix findings plus
 * reviewer comments and the overall note. Shape is intentionally open — it is
 * JSON-serialised verbatim into the prompt (mirrors Python `list[dict]`).
 */
export type RefineNote = Record<string, unknown>;

export interface RunWriterInput {
  run: WriterRunInput;
  outline: object;
  gapAnalysis?: object | null;
  existingMarkdown?: string | null;
  refineNotes?: RefineNote[] | null;
  iteration: number;
  onThought?: ThoughtCallback;
}

export interface RunWriterResult {
  draftId: string;
  diagnose: string;
  markupRaw: string;
  citationIntents: CitationIntent[];
  groundingChunks: unknown[] | null;
  tokens: {
    tokensIn: number;
    tokensOut: number;
    thinkingTokens: number;
    latencyMs: number;
  };
}

// ---------------------------------------------------------------------------
// Structural validation — mirrors _markup_structural_issues() in writer.py
// ---------------------------------------------------------------------------

// Matches a `%%meta desc=...%%` line anywhere in the markup (multiline). Mirrors
// the Python regex `^%%meta desc=.*?%%\s*$` with re.MULTILINE.
const META_LINE_RE = /^%%meta desc=[\s\S]*?%%[ \t]*$/m;

/**
 * Return human-readable descriptions of any structural rules the writer broke
 * that would cause render_html to hard-fail. Empty array = clean. Mirrors the
 * Python checks exactly: the first line must start with `# ` (H1) AND the markup
 * must contain a `%%meta desc=...%%` line.
 */
export function markupStructuralIssues(markup: string): string[] {
  const issues: string[] = [];
  const lines = markup.split("\n");
  const first = lines.length > 0 ? lines[0] ?? "" : "";
  if (!first.startsWith("# ")) {
    issues.push(
      "第一行必須係 `# H1 標題`，唔可以有空行、code fence、註解或任何其他內容喺前面。",
    );
  }
  if (!META_LINE_RE.test(markup)) {
    issues.push(
      "緊接 H1 嘅下一行必須係 `%%meta desc=<具體、自然、可讀嘅描述>%%`，唔可以漏。",
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/** Select the writer route — mirrors the Python route ternary in run_writer. */
function selectRoute(run: WriterRunInput): string {
  return run.startMode === "create"
    ? "create"
    : run.chosenRoute || "small_refresh";
}

/** Today's date as an ISO `YYYY-MM-DD` string (mirrors today.isoformat()). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function buildSystemPrompt(
  sql: Sql,
  route: string,
  personaName: string,
  contextText: string,
): Promise<string> {
  const template = await getAssembled(sql, `writer_${route}`);
  const persona = await loadPersona(sql, personaName);
  const policy = new SourcePolicy();
  return template
    .replace("{persona_block}", toPromptBlock(persona, contextText))
    .replace("{today_date}", todayIso())
    .replace("{source_policy_block}", policy.toPromptBlock());
}

/**
 * Build the writer user prompt — EXACT field order, labels, and JSON encoding
 * from Python `build_user_prompt`. JSON.stringify (no spacing) mirrors
 * `json.dumps(..., ensure_ascii=False)`; non-ASCII is preserved by default.
 */
export function buildUserPrompt(input: {
  run: WriterRunInput;
  gapAnalysis: object;
  outline: object;
  existingMarkdown: string;
  refineNotes: RefineNote[] | null;
}): string {
  const { run, gapAnalysis, outline, existingMarkdown, refineNotes } = input;
  let base =
    `topic: ${run.topic}\n` +
    `focus_keywords: ${run.keywords.join(", ")}\n` +
    `existing_article_URL: ${run.articleUrl}\n` +
    `acf_adv_id: ${run.acfAdvId}\n` +
    `acf_widget_id: ${run.acfWidgetId}\n` +
    `topic_category: ${run.topicCategory || "N/A"}\n\n` +
    `# outline\n${JSON.stringify(outline)}\n\n` +
    `# gap_analysis\n${JSON.stringify(gapAnalysis)}\n\n` +
    `# existing_article_markdown\n${existingMarkdown}\n`;
  if (run.editNote) {
    base +=
      `\n# editor_instruction（編輯指示 · 最優先）\n` + `${run.editNote}\n`;
  }
  if (refineNotes && refineNotes.length > 0) {
    base +=
      `\n# refine_notes（上一輪 audit 必修問題）\n` +
      `${JSON.stringify(refineNotes)}\n`;
  }
  return base;
}

/** Correction block appended to the user prompt on a structural retry. */
function buildCorrection(issues: string[]): string {
  return (
    "\n\n# 上一次輸出唔合格，必須修正以下結構問題並重新輸出完整 markup：" +
    "（唔好只輸出修補段，要重寫整篇）\n" +
    issues.map((i) => `- ${i}`).join("\n")
  );
}

// ---------------------------------------------------------------------------
// Gemini parse — narrow the untyped parsed object into WriterOutput.
// ---------------------------------------------------------------------------

function parseWriterOutput(parsed: Record<string, unknown>): WriterOutput {
  const diagnose = parsed["diagnose"];
  const markup = parsed["markup"];
  const rawIntents = parsed["citation_intents"];
  if (typeof diagnose !== "string" || typeof markup !== "string") {
    throw new Error("writer output missing required string fields");
  }
  const citationIntents: CitationIntent[] = Array.isArray(rawIntents)
    ? rawIntents.map((c): CitationIntent => {
        const obj = (c ?? {}) as Record<string, unknown>;
        return {
          claim: typeof obj["claim"] === "string" ? obj["claim"] : "",
          why_cited:
            typeof obj["why_cited"] === "string" ? obj["why_cited"] : "",
        };
      })
    : [];
  return { diagnose, markup, citation_intents: citationIntents };
}

// ---------------------------------------------------------------------------
// DB write — upsert content_tool.drafts on (run_id, iteration).
// ---------------------------------------------------------------------------

async function upsertDraft(
  sql: Sql,
  values: {
    runId: string;
    iteration: number;
    diagnose: string;
    markupRaw: string;
    citationIntents: CitationIntent[];
    groundingChunks: unknown[] | null;
    tokensIn: number;
    tokensOut: number;
    thinkingTokens: number;
    latencyMs: number;
  },
): Promise<string> {
  // draft_id has no DB default; supply one for the INSERT branch. On conflict
  // RETURNING yields the existing row's id (the discarded INSERT id differs).
  const draftId = crypto.randomUUID();

  const rows = await sql<Array<{ draft_id: string }>>`
    INSERT INTO content_tool.drafts (
      draft_id, run_id, iteration, diagnose, markup_raw, final_markup,
      citation_intents, grounding_chunks,
      tokens_in, tokens_out, thinking_tokens, latency_ms
    ) VALUES (
      ${draftId}::uuid,
      ${values.runId}::uuid,
      ${values.iteration},
      ${values.diagnose},
      ${values.markupRaw},
      ${null},
      ${toJsonb(sql, values.citationIntents)},
      ${values.groundingChunks === null ? null : toJsonb(sql, values.groundingChunks)},
      ${values.tokensIn},
      ${values.tokensOut},
      ${values.thinkingTokens},
      ${values.latencyMs}
    )
    ON CONFLICT (run_id, iteration) DO UPDATE SET
      diagnose = ${values.diagnose},
      markup_raw = ${values.markupRaw},
      final_markup = ${null},
      citation_intents = ${toJsonb(sql, values.citationIntents)},
      grounding_chunks = ${values.groundingChunks === null ? null : toJsonb(sql, values.groundingChunks)},
      tokens_in = ${values.tokensIn},
      tokens_out = ${values.tokensOut},
      thinking_tokens = ${values.thinkingTokens},
      latency_ms = ${values.latencyMs}
    RETURNING draft_id
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new Error("draft upsert returned no row");
  }
  return row.draft_id;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the writer node: assemble prompts, generate the draft markup (with a
 * single structural-retry), and upsert into content_tool.drafts. Returns the
 * persisted draft id along with the raw markup, citation intents, grounding
 * chunks, diagnose note, and accumulated token usage.
 */
export async function runWriter(
  sql: Sql,
  gemini: GeminiClient,
  input: RunWriterInput,
): Promise<RunWriterResult> {
  const { run, outline, iteration, onThought } = input;
  const gapAnalysis = input.gapAnalysis ?? {};
  // Create-mode runs have no fetched article on disk — fall back to "" so the
  // template renders cleanly (mirrors the Python fa_markdown fallback).
  const existingMarkdown = input.existingMarkdown ?? "";
  const refineNotes = input.refineNotes ?? null;

  const route = selectRoute(run);
  // Writer context for glossary filtering: topic + keywords + outline JSON +
  // existing markdown, concatenated exactly as in Python writer_context.
  const writerContext =
    `${run.topic}\n${run.keywords.join(" ")}\n` +
    `${JSON.stringify(outline)}\n${existingMarkdown}`;

  const systemPrompt = await buildSystemPrompt(
    sql,
    route,
    run.persona,
    writerContext,
  );
  const userPrompt = buildUserPrompt({
    run,
    gapAnalysis,
    outline,
    existingMarkdown,
    refineNotes,
  });

  const result = await gemini.generate({
    agent: "writer",
    systemPrompt,
    userPrompt,
    responseSchema: WRITER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    tools: ["googleSearch", "urlContext"],
    ...(onThought ? { onThought } : {}),
  });

  let out = parseWriterOutput(result.parsed);
  let groundingChunks: unknown[] | null = result.groundingChunks;
  let tokensIn = result.tokensIn;
  let tokensOut = result.tokensOut;
  let thinkingTokens = result.thinkingTokens;
  let latencyMs = result.latencyMs;

  const issues = markupStructuralIssues(out.markup);
  if (issues.length > 0) {
    // Gemini sometimes drops the leading H1 or the %%meta desc=...%% line even
    // though the prompt requires them. Regenerate once with the specific
    // failures called out, then accumulate token usage across both attempts.
    const retry = await gemini.generate({
      agent: "writer",
      systemPrompt,
      userPrompt: userPrompt + buildCorrection(issues),
      responseSchema:
        WRITER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      tools: ["googleSearch", "urlContext"],
      ...(onThought ? { onThought } : {}),
    });
    const retryOut = parseWriterOutput(retry.parsed);
    const retryIssues = markupStructuralIssues(retryOut.markup);
    if (retryIssues.length > 0) {
      throw new Error(
        "writer output failed structural rules after retry: " +
          retryIssues.join("; "),
      );
    }
    out = retryOut;
    tokensIn += retry.tokensIn;
    tokensOut += retry.tokensOut;
    thinkingTokens += retry.thinkingTokens;
    latencyMs += retry.latencyMs;
    groundingChunks = retry.groundingChunks;
  }

  const draftId = await upsertDraft(sql, {
    runId: run.runId,
    iteration,
    diagnose: out.diagnose,
    markupRaw: out.markup,
    citationIntents: out.citation_intents,
    groundingChunks,
    tokensIn,
    tokensOut,
    thinkingTokens,
    latencyMs,
  });

  return {
    draftId,
    diagnose: out.diagnose,
    markupRaw: out.markup,
    citationIntents: out.citation_intents,
    groundingChunks,
    tokens: { tokensIn, tokensOut, thinkingTokens, latencyMs },
  };
}
