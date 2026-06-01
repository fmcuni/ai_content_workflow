/**
 * Render an example *user* prompt for a given run + agent — TypeScript port of
 * `_render_user_prompt` in `content_tool/api/routes/prompts.py`.
 *
 * Reuses the exact agent `buildUserPrompt` builders (byte-for-byte ports of the
 * Python ones) so the example matches what the production workflow feeds Gemini.
 * Loads the run + whatever derived rows each agent needs; throws `MissingInputs`
 * when a prerequisite row is absent (route → HTTP 422) and returns `null` when
 * the run itself does not exist (route → HTTP 404).
 */

import type { Sql } from "postgres";
import { pgJson } from "../db/serialize";
import { buildUserPrompt as buildGapUserPrompt } from "../agents/gap_analysis";
import {
  buildUserPromptCreateMode as buildOutlineCreate,
  buildUserPromptRefresh as buildOutlineRefresh,
} from "../agents/outline";
import { buildUserPrompt as buildWriterUserPrompt } from "../agents/writer";
import { buildUserPrompt as buildAuditUserPrompt } from "../agents/audit";
import type { AuditFinding } from "../agents/schemas";

/** Agents the user-example endpoint can render (matches `_USER_PROMPT_AGENTS`). */
export const USER_PROMPT_AGENTS: ReadonlySet<string> = new Set([
  "gap_analysis",
  "outline",
  "writer",
  "audit",
]);

/** Raised when a required derived row is missing (route maps to HTTP 422). */
export class MissingInputs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingInputs";
  }
}

type GapMode = "auto" | "small_refresh" | "full_rewrite";

interface RunRow {
  run_id: string;
  topic: string;
  keywords: unknown;
  article_url: string | null;
  acf_adv_id: number;
  acf_widget_id: number;
  mode: string;
  edit_note: string | null;
  start_mode: string;
  chosen_route: string | null;
  target_audience: string | null;
  topic_category: string | null;
  persona: string;
}

async function loadRun(sql: Sql, runId: string): Promise<RunRow | null> {
  const rows = await sql<RunRow[]>`
    SELECT
      run_id, topic, keywords, article_url, acf_adv_id, acf_widget_id, mode,
      edit_note, start_mode, chosen_route, target_audience, topic_category, persona
    FROM content_tool.runs
    WHERE run_id = ${runId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadGapPayload(sql: Sql, runId: string): Promise<unknown | null> {
  const rows = await sql<{ payload: unknown }[]>`
    SELECT payload FROM content_tool.gap_analyses WHERE run_id = ${runId} LIMIT 1
  `;
  return rows[0] === undefined ? null : pgJson(rows[0].payload);
}

async function loadFetchedMarkdown(sql: Sql, runId: string): Promise<string | null> {
  const rows = await sql<{ markdown: string | null }[]>`
    SELECT markdown FROM content_tool.fetched_articles WHERE run_id = ${runId} LIMIT 1
  `;
  return rows[0] === undefined ? null : (rows[0].markdown ?? "");
}

async function loadOutlinePayload(sql: Sql, runId: string): Promise<unknown | null> {
  const rows = await sql<{ payload: unknown }[]>`
    SELECT payload FROM content_tool.outlines WHERE run_id = ${runId} LIMIT 1
  `;
  return rows[0] === undefined ? null : pgJson(rows[0].payload);
}

/** Read `obj[key]` as a plain object, defaulting to `{}` (mirrors dict.get(k, {})). */
function objectField(value: unknown, key: string): object {
  if (value !== null && typeof value === "object" && key in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>)[key];
    if (inner !== null && typeof inner === "object") {
      return inner;
    }
  }
  return {};
}

/** Read `obj[key]` as an array, defaulting to `[]` (mirrors dict.get(k, [])). */
function objectFieldArray(value: unknown, key: string): unknown[] {
  if (value !== null && typeof value === "object" && key in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) {
      return inner;
    }
  }
  return [];
}

function renderGap(run: RunRow): string {
  return buildGapUserPrompt({
    topic: run.topic,
    keywords: pgJson<string[]>(run.keywords) ?? [],
    articleUrl: run.article_url ?? "",
    acfAdvId: run.acf_adv_id,
    acfWidgetId: run.acf_widget_id,
    mode: run.mode as GapMode,
    editNote: run.edit_note,
  });
}

async function renderOutline(sql: Sql, run: RunRow): Promise<string> {
  const keywords = pgJson<string[]>(run.keywords) ?? [];
  if (run.start_mode === "create") {
    return buildOutlineCreate({
      topic: run.topic,
      keywords,
      targetAudience: run.target_audience,
      acfAdvId: run.acf_adv_id,
      acfWidgetId: run.acf_widget_id,
      editNote: run.edit_note,
    });
  }
  const gap = await loadGapPayload(sql, run.run_id);
  const markdown = await loadFetchedMarkdown(sql, run.run_id);
  if (gap === null || markdown === null) {
    throw new MissingInputs("outline needs gap_analysis + fetched_article");
  }
  return buildOutlineRefresh({
    gapAnalysisPayload: (gap as object) ?? {},
    existingMarkdown: markdown,
    chosenRoute: run.chosen_route ?? "small_refresh",
    acfAdvId: run.acf_adv_id,
    acfWidgetId: run.acf_widget_id,
  });
}

async function renderWriter(sql: Sql, run: RunRow): Promise<string> {
  const outline = await loadOutlinePayload(sql, run.run_id);
  const gap = await loadGapPayload(sql, run.run_id);
  const markdown = await loadFetchedMarkdown(sql, run.run_id);
  const isCreate = run.start_mode === "create";
  if (outline === null || (!isCreate && (gap === null || markdown === null))) {
    throw new MissingInputs(
      "writer needs outline (+ gap_analysis + fetched_article in refresh)",
    );
  }
  return buildWriterUserPrompt({
    run: {
      runId: run.run_id,
      topic: run.topic,
      keywords: pgJson<string[]>(run.keywords) ?? [],
      articleUrl: run.article_url,
      acfAdvId: String(run.acf_adv_id),
      acfWidgetId: String(run.acf_widget_id),
      topicCategory: run.topic_category,
      persona: run.persona,
      startMode: run.start_mode,
      chosenRoute: run.chosen_route,
      editNote: run.edit_note,
    },
    gapAnalysis: (gap as object) ?? {},
    outline: outline as object,
    existingMarkdown: markdown ?? "",
    refineNotes: null,
  });
}

async function renderAudit(sql: Sql, run: RunRow): Promise<string> {
  const draftRows = await sql<{ draft_id: string; citation_intents: unknown }[]>`
    SELECT draft_id, citation_intents
    FROM content_tool.drafts
    WHERE run_id = ${run.run_id}
    ORDER BY iteration DESC
    LIMIT 1
  `;
  const draft = draftRows[0];
  if (draft === undefined) {
    throw new MissingInputs("audit needs a draft");
  }

  const gap = await loadGapPayload(sql, run.run_id);
  if (gap === null) {
    throw new MissingInputs("audit needs gap_analysis");
  }

  const renderRows = await sql<{ html_body: string }[]>`
    SELECT html_body FROM content_tool.renders WHERE draft_id = ${draft.draft_id} LIMIT 1
  `;
  const render = renderRows[0];
  if (render === undefined) {
    throw new MissingInputs("audit needs a render");
  }

  const citationRows = await sql<
    {
      domain: string | null;
      final_url: string | null;
      policy_decision: string | null;
      was_displayed: boolean | null;
      denied_reason: string | null;
    }[]
  >`
    SELECT domain, final_url, policy_decision, was_displayed, denied_reason
    FROM content_tool.citations
    WHERE draft_id = ${draft.draft_id}
    ORDER BY chunk_idx ASC
  `;
  const citationsSummary = citationRows.map((c) => ({
    domain: c.domain,
    final_url: c.final_url,
    policy: c.policy_decision,
    displayed: c.was_displayed,
    denied_reason: c.denied_reason,
  }));

  const auditRows = await sql<{ deterministic_findings: unknown }[]>`
    SELECT deterministic_findings FROM content_tool.audit_runs
    WHERE draft_id = ${draft.draft_id} LIMIT 1
  `;
  const detFindings =
    auditRows[0] === undefined
      ? []
      : objectFieldArray(pgJson(auditRows[0].deterministic_findings), "findings");

  return buildAuditUserPrompt({
    htmlBody: render.html_body,
    gapUpdatePlan: objectField(gap, "update_plan"),
    citationIntents: (pgJson<object[]>(draft.citation_intents) ?? []) as object[],
    citationsSummary,
    deterministicFindings: detFindings as AuditFinding[],
  });
}

/**
 * Render the example user prompt for `agent` against `runId`.
 * Returns the prompt string, or `null` when the run does not exist. Throws
 * `MissingInputs` when a required derived row is absent.
 */
export async function renderUserPrompt(
  sql: Sql,
  runId: string,
  agent: string,
): Promise<string | null> {
  const run = await loadRun(sql, runId);
  if (run === null) {
    return null;
  }
  switch (agent) {
    case "gap_analysis":
      return renderGap(run);
    case "outline":
      return renderOutline(sql, run);
    case "writer":
      return renderWriter(sql, run);
    case "audit":
      return renderAudit(sql, run);
    default:
      // The route validates the agent name before calling; this is unreachable.
      throw new MissingInputs(`unsupported agent '${agent}'`);
  }
}
