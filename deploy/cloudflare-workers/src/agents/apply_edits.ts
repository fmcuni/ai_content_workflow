// APPLY-EDITS node — TypeScript port of content_tool/agents/apply_edits.py.
//
// Targeted, surgical edits to an already-rendered HTML article driven by reviewer
// feedback — anchored `comments` (each tied to a highlighted span) and/or an
// overall `notes` direction. Unlike the writer, this never regenerates from the
// outline / gap analysis: it revises the *existing output* in place and returns
// the full revised HTML.
//
// The prompt strings (system + user) are reproduced byte-for-byte from the
// Python source so Gemini receives identical input across runtimes.

import type { Sql } from "postgres";
import type { GeminiClient, ThoughtCallback } from "../gemini/types";
import { loadPersona, toPromptBlock } from "./persona";

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

/** A single anchored comment (wire shape — mirrors Hitl2Comment). */
export interface ApplyEditComment {
  anchor_text: string;
  body: string;
}

export interface RunApplyEditsInput {
  runId: string;
  htmlBody: string;
  comments: ApplyEditComment[];
  notes: string | null;
  onThought?: ThoughtCallback;
}

// {persona_block} is substituted with the run persona's prompt block so edits
// stay on-voice (glossary, banned terms, required HK phrasings).
export const SYSTEM_PROMPT =
  "你係 Bowtie 嘅資深中文編輯。你會收到一篇【已完成】嘅 HTML 文章，" +
  "同埋審稿人嘅修改要求。你嘅工作係**就住要求精準噉修改現有 HTML**，" +
  "唔係由頭重寫成篇文。\n\n" +
  "規則：\n" +
  "- 只係改要求所指嘅內容；其餘段落、標題、連結、HTML 標籤同屬性" +
  "（包括 class、id、data-* 屬性，以及 shortcode 例如 [adv_panel id=\"…\"]、" +
  "[page_widget id=\"…\"]）必須原封不動保留。\n" +
  "- 維持原有 HTML 結構；唔好用 markdown、code fence 或者註解包住輸出。\n" +
  "- 針對某段 highlight 嘅 comment：搵返 anchor 文字所在嘅位置，" +
  "按指示修改嗰一處。\n" +
  "- overall note：就成篇文做整體調整，但要維持最小改動原則，" +
  "唔好亂改無關段落。\n" +
  "- 你可能會見到 <span data-comment-id=\"…\"> 包住嘅文字，嗰啲係編輯標註。" +
  "你處理完對應嘅 comment 之後，可以將嗰個 span 拆走、淨返入面文字；" +
  "其他未處理嘅 comment span 必須保留。\n" +
  "- 維持原文嘅語氣同人格。\n\n" +
  "{persona_block}\n" +
  "輸出 JSON：html_body（修改後嘅完整 HTML）、" +
  "diagnose（你做咗咩修改，一兩句總結）。";

/** JSON schema for the structured reply (mirrors ApplyEditsOutput). */
export const APPLY_EDITS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    html_body: { type: "string" },
    diagnose: { type: "string" },
  },
  required: ["html_body"],
} as const;

/**
 * Assemble the reviewer-feedback user prompt. Only sections that carry real
 * feedback are emitted. Output is byte-identical to the Python `build_user_prompt`.
 */
export function buildUserPrompt(input: {
  htmlBody: string;
  comments: ApplyEditComment[];
  notes: string | null;
}): string {
  const { htmlBody, comments, notes } = input;
  const sections: string[] = [`# 現有文章 HTML\n${htmlBody}`];
  const live = comments.filter((c) => (c.body ?? "").trim().length > 0);
  if (live.length > 0) {
    const lines = live
      .map((c) => `- highlight：「${c.anchor_text}」\n  要求：${c.body}`)
      .join("\n");
    sections.push(`# 針對 highlight 嘅修改要求（comments）\n` + lines);
  }
  if (notes && notes.trim().length > 0) {
    sections.push(`# 整體修改方向（overall note）\n${notes}`);
  }
  return sections.join("\n\n") + "\n";
}

/** Narrow the untyped parsed object to the revised HTML string. */
export function parseApplyEditsOutput(parsed: Record<string, unknown>): string {
  const html = parsed["html_body"];
  if (typeof html !== "string") {
    throw new Error("apply_edits output missing html_body");
  }
  return html;
}

/**
 * Apply reviewer feedback to `htmlBody` and return the revised HTML. Loads the
 * run's persona for on-voice editing. Throws `run not found: <id>` when the run
 * row is missing so the route can map it to a 404.
 */
export async function runApplyEdits(
  sql: Sql,
  gemini: GeminiClient,
  input: RunApplyEditsInput,
): Promise<string> {
  const rows = await sql<Array<{ persona: string }>>`
    SELECT persona FROM content_tool.runs WHERE run_id = ${input.runId}::uuid LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`run not found: ${input.runId}`);
  }

  const persona = await loadPersona(sql, row.persona);
  const systemPrompt = SYSTEM_PROMPT.replace(
    "{persona_block}",
    toPromptBlock(persona, input.htmlBody),
  );
  const userPrompt = buildUserPrompt({
    htmlBody: input.htmlBody,
    comments: input.comments,
    notes: input.notes,
  });

  const result = await gemini.generate({
    agent: "apply_edits",
    systemPrompt,
    userPrompt,
    responseSchema: APPLY_EDITS_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    tools: [],
    ...(input.onThought ? { onThought: input.onThought } : {}),
  });

  return parseApplyEditsOutput(result.parsed);
}
