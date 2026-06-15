/**
 * Read-only editor references per agent template: the *shape* of the user
 * prompt the production workflow sends alongside each system prompt, and the
 * Gemini `responseSchema` (structured output) the agent is called with.
 *
 * The user-prompt reference strings are hand-maintained mirrors of the
 * `buildUserPrompt` builders — `{placeholders}` mark run-derived values and
 * `← only when …` lines mark conditional sections. Keep each entry in sync
 * with its builder (noted per entry). The schema constants are the real
 * objects passed to Gemini, so those can never drift.
 *
 * Keep the reference strings byte-identical with the Python mirror in
 * `content_tool/api/routes/prompts.py` (_USER_PROMPT_REFERENCES).
 */

import {
  GAP_ANALYSIS_SCHEMA,
  OUTLINE_SCHEMA,
  WRITER_OUTPUT_SCHEMA,
  AUDIT_OUTPUT_SCHEMA,
} from "../agents/schemas";
import {
  TOPIC_GEN_SCHEMA,
  TOPIC_DEDUP_SCHEMA,
  TOPIC_HOT_SCHEMA,
} from "../agents/topic_schemas";

export interface TemplateReferences {
  user_prompt_template: string | null;
  response_json_schema: Record<string, unknown> | null;
}

// Shared by writer_create / writer_full_rewrite / writer_small_refresh —
// mirrors src/agents/writer.ts buildUserPrompt.
const WRITER_USER_PROMPT = `topic: {topic}
focus_keywords: {keywords, comma-separated}
existing_article_URL: {article_url}
acf_adv_id: {acf_adv_id}
acf_widget_id: {acf_widget_id}
topic_category: {topic_category, or "N/A"}

# outline
{outline payload, JSON}

# gap_analysis
{gap_analysis payload, JSON}

# existing_article_markdown
{fetched article markdown — empty in create mode}

# editor_instruction（編輯指示 · 最優先）   ← only when an edit note is set
{edit_note}

# refine_notes（上一輪 audit 必修問題）   ← only on refine iterations
{refine_notes, JSON}`;

// Mirrors src/agents/<agent>.ts buildUserPrompt (builder noted per entry).
const USER_PROMPT_TEMPLATES: Readonly<Record<string, string>> = {
  // src/agents/gap_analysis.ts
  gap_analysis: `topic: {topic}
focus_keywords: {keywords, comma-separated}
existing_article: {article_url}
acf_adv_id: {acf_adv_id}
acf_widget_id: {acf_widget_id}
route: {mode — "Auto (follow existing logic)" or "<mode> (override existing logic)"}
article_edit_note: {edit_note, or "N/A"}`,

  // src/agents/outline.ts buildUserPromptCreateMode
  outline_create_mode: `主題：{topic}
關鍵字：{keywords, comma-separated, or "(無)"}
目標讀者：{target_audience, or "(未指定)"}
acf_adv_id: {acf_adv_id}
acf_widget_id: {acf_widget_id}
編輯指示（最優先）：{edit_note}   ← only when an edit note is set`,

  // src/agents/outline.ts buildUserPromptRefresh
  outline_rewrite_mode: `chosen_route: {chosen_route}
acf_adv_id: {acf_adv_id}
acf_widget_id: {acf_widget_id}

# gap_analysis
{gap_analysis payload, JSON}

# existing_article_markdown
{fetched article markdown}`,

  writer_create: WRITER_USER_PROMPT,
  writer_full_rewrite: WRITER_USER_PROMPT,
  writer_small_refresh: WRITER_USER_PROMPT,

  // src/agents/audit.ts
  audit: `# final_html
{rendered html_body}

# gap_analysis.update_plan
{gap_analysis.update_plan, JSON}

# citation_intents
{draft citation_intents, JSON}

# citations (resolved)
{resolved citations summary, JSON}

# deterministic_findings
{deterministic findings, JSON}

# edit_note (operator brief)   ← only when an edit note is set
{edit_note}`,

  // src/agents/topic_gen.ts
  topic_gen: `請根據以下研究設定產出結果。

研究主題：{research_theme}
目標受眾：{target_audience}
主題數量：{topic_count}
每個主題關鍵字數量：{keywords_per_topic}

必須涵蓋範疇：
{must_cover, one per line}

避免主題：
{must_avoid, one per line}

額外偏重方向：
{priority_focus, or （無）}

補充要求：
{notes, or （無）}`,

  // src/agents/topic_dedup.ts (stage 2 judge)
  topic_dedup: `請判斷以下單一 topic 在 site:bowtie.com.hk/blog 是否已有相同 topic 的文章。只輸出符合 schema 的 JSON。

topic:
{topic}

focus_keywords:
{keywords, comma-separated, or （無）}

{existing_articles — stage-1 grounded search results, title + URL per candidate}`,

  // src/agents/topic_hot.ts — {market} is filled from the voice's locale by the
  // /schema route (mirrors topic_hot buildUserPrompt).
  topic_hot: `請分析以下單一 topic 在 {market} SERP 是否屬於熱門話題。只輸出符合 schema 的 JSON。

topic:
{topic}

focus_keywords:
{keywords, comma-separated, or （無）}`,

  // src/agents/topic_existing_search.ts (stage 1 — grounded search, plain-text reply)
  topic_existing_search: `請用 googleSearch 實際搜尋 site:bowtie.com.hk/blog，找出與以下 topic 最相關的現有文章，列出標題與完整 URL。

topic:
{topic}

focus_keywords:
{keywords, comma-separated, or （無）}`,
};

// The real responseSchema constants each agent passes to Gemini.
// topic_existing_search deliberately has none (plain text — grounding chunks
// are harvested, not the prose).
const RESPONSE_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  gap_analysis: GAP_ANALYSIS_SCHEMA as Record<string, unknown>,
  outline_create_mode: OUTLINE_SCHEMA as Record<string, unknown>,
  outline_rewrite_mode: OUTLINE_SCHEMA as Record<string, unknown>,
  writer_create: WRITER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  writer_full_rewrite: WRITER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  writer_small_refresh: WRITER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  audit: AUDIT_OUTPUT_SCHEMA as Record<string, unknown>,
  topic_gen: TOPIC_GEN_SCHEMA as Record<string, unknown>,
  topic_dedup: TOPIC_DEDUP_SCHEMA as Record<string, unknown>,
  topic_hot: TOPIC_HOT_SCHEMA as Record<string, unknown>,
};

/** References for a template id; both fields null for partials/unknown ids. */
export function referencesFor(templateId: string): TemplateReferences {
  return {
    user_prompt_template: USER_PROMPT_TEMPLATES[templateId] ?? null,
    response_json_schema: RESPONSE_SCHEMAS[templateId] ?? null,
  };
}
