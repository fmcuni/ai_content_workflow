import { Hono } from "hono";
import type { Sql } from "postgres";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { pgJson, pgTimestampToIso, toJsonb } from "../db/serialize";
import { runApplyEdits, type ApplyEditComment } from "../agents/apply_edits";
import { DoGeminiClient } from "../gemini/do_client";
import {
  buildMeta,
  detectSeoPlugin,
  WordPressClient,
  WordPressError,
} from "../wordpress/client";
import type { PublishPayload, SeoPlugin } from "../wordpress/client";
import { resolvePublishStatus } from "../wordpress/publish_status";
import { restartGuard } from "./run_guards";
import type { AuthVars } from "../auth/middleware";
import { resolveActorIdentity } from "./identity";
import { requireRole } from "../auth/authz";
import { corsPreflight, resolveCorsOrigin, withCors } from "../http/cors";

// ---------------------------------------------------------------------------
// Env extension
//
// The shared `Env` interface (src/index.ts) does not yet declare the PRODUCTION
// Workflow binding. The integration agent owns index.ts; this file must not edit
// it. We narrow locally so this module typechecks against the fixed contract.
// ---------------------------------------------------------------------------

// TODO: integration agent adds PRODUCTION to Env
interface RunsEnv extends Env {
  PRODUCTION: Workflow<{ runId: string }>;
}

// ---------------------------------------------------------------------------
// Constants — mirror content_tool/wordpress/client.py
// ---------------------------------------------------------------------------

const WP_DEFAULT_PAGE_TEMPLATE = "";

// Statuses where the LangGraph is still actively driving the run.
const DEFAULT_LIST_LIMIT = 50;

// HITL_2 request_changes cap — must match the Python guard.
const HITL_2_MAX_ITERATIONS = 3;

// Run-status sentinels the ProductionWorkflow sets WHILE PAUSED at each HITL gate
// (src/workflows/production.ts gateStep). A decision is only valid when the run
// is parked at the matching gate, so the resume/hitl-2 handlers claim the
// transition with `AND status = <gate status>` — this both rejects stale-tab
// posts and single-flights the sendEvent to the workflow instance.
const HITL_1_GATE_STATUS = "hitl_1";
const HITL_2_GATE_STATUS = "hitl_2";

// Gemini defaults for the synchronous apply-edits route (mirror refresh.ts).
const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_THINKING_LEVEL = "HIGH";

const VALID_START_MODES = ["refresh", "create"] as const;
type StartMode = (typeof VALID_START_MODES)[number];

// ---------------------------------------------------------------------------
// Request body types (mirror web/lib/api.ts + content_tool/api/schemas.py)
// ---------------------------------------------------------------------------

interface CreateRunBody {
  topic?: string;
  keywords?: string[];
  mode?: string;
  acf_adv_id?: number;
  acf_widget_id?: number;
  editor_email?: string;
  article_url?: string | null;
  persona?: string;
  topic_category?: string | null;
  edit_note?: string | null;
  start_mode?: string;
  topic_candidate_id?: string | null;
  target_audience?: string | null;
  triggered_by_evaluation_id?: string | null;
}

interface ResumeBody {
  decision?: "approve" | "edit_outline" | "override_route" | "cancel";
  edited_outline?: unknown;
  new_route?: string | null;
  notes?: string | null;
}

interface Hitl2Comment {
  id: string;
  anchor_text: string;
  body: string;
}

interface Hitl2Body {
  decision?: "approve" | "request_changes" | "reject";
  notes?: string | null;
  comments?: Hitl2Comment[];
  /** Ignored for audit fields when a session identity is present — `approved_by`
   * is session-derived (see ./identity). Accepted only as a dev fallback. */
  editor_email?: string | null;
  edited_html_body?: string | null;
  edited_seo_title?: string | null;
  edited_meta_description?: string | null;
  wp_publish_status?: string | null;
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  wp_publish_at?: string | null;
}

interface DryPublishBody {
  edited_html_body?: string | null;
  edited_seo_title?: string | null;
  edited_meta_description?: string | null;
  wp_publish_status?: string | null;
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  wp_publish_at?: string | null;
}

// ---------------------------------------------------------------------------
// Output types (mirror the Python list_runs / get_run dicts)
// ---------------------------------------------------------------------------

interface RunSummary {
  run_id: string;
  status: string;
  topic: string;
  article_url: string | null;
  mode: string;
  keywords: unknown;
  persona: string;
  acf_adv_id: number;
  acf_widget_id: number;
  edit_note: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string;
  chosen_route: string | null;
  iteration_count: number;
  hitl_2_iteration: number;
  approved_at: string | null;
  approved_by: string | null;
  hitl_2_decision: string | null;
  hitl_2_notes: string | null;
  wp_publish_status: string | null;
  wp_author_id: number | null;
  wp_category_ids: unknown;
  wp_tag_ids: unknown;
  wp_featured_media_id: number | null;
  wp_slug: string | null;
  wp_excerpt: string | null;
  wp_pushed_post_id: number | null;
  wp_pushed_at: string | null;
  wp_push_error: unknown;
  start_mode: string;
  topic_candidate_id: string | null;
  target_audience: string | null;
  error: unknown;
}

// ---------------------------------------------------------------------------
// Row types (only the columns each query selects)
// ---------------------------------------------------------------------------

interface RunListRow {
  run_id: string;
  status: string;
  topic: string;
  article_url: string | null;
  mode: string;
  created_at: string;
  chosen_route: string | null;
  iteration_count: number;
  start_mode: string;
  target_audience: string | null;
  keywords: unknown;
  persona: string;
  acf_adv_id: number;
  acf_widget_id: number;
  edit_note: string | null;
}

interface RunDetailRow extends RunListRow {
  updated_at: string;
  created_by: string;
  hitl_2_iteration: number;
  approved_at: string | null;
  approved_by: string | null;
  hitl_2_decision: string | null;
  hitl_2_notes: string | null;
  wp_publish_status: string | null;
  wp_author_id: number | null;
  wp_category_ids: unknown;
  wp_tag_ids: unknown;
  wp_featured_media_id: number | null;
  wp_slug: string | null;
  wp_excerpt: string | null;
  wp_pushed_post_id: number | null;
  wp_pushed_at: string | null;
  wp_push_error: unknown;
  topic_candidate_id: string | null;
  error: unknown;
}

interface RunHitl2StateRow {
  status: string;
  hitl_2_iteration: number;
}

interface RunDryPublishRow {
  start_mode: string;
  wp_publish_status: string | null;
  wp_category_ids: unknown;
  wp_tag_ids: unknown;
  wp_excerpt: string | null;
  wp_slug: string | null;
  wp_author_id: number | null;
  wp_featured_media_id: number | null;
  wp_publish_at: string | null;
  wp_pushed_post_id: number | null;
}

interface RenderDryPublishRow {
  seo_title: string;
  meta_description: string;
  html_body: string;
  excerpt_suggestion: string | null;
  slug_suggestion: string | null;
  schema_jsonld: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRunSummary(row: RunDetailRow): RunSummary {
  return {
    run_id: row.run_id,
    status: row.status,
    topic: row.topic,
    article_url: row.article_url,
    mode: row.mode,
    keywords: pgJson(row.keywords),
    persona: row.persona,
    acf_adv_id: row.acf_adv_id,
    acf_widget_id: row.acf_widget_id,
    edit_note: row.edit_note,
    created_at: pgTimestampToIso(row.created_at),
    updated_at: pgTimestampToIso(row.updated_at),
    created_by: row.created_by,
    chosen_route: row.chosen_route,
    iteration_count: row.iteration_count,
    hitl_2_iteration: row.hitl_2_iteration,
    approved_at: pgTimestampToIso(row.approved_at),
    approved_by: row.approved_by,
    hitl_2_decision: row.hitl_2_decision,
    hitl_2_notes: row.hitl_2_notes,
    wp_publish_status: row.wp_publish_status,
    wp_author_id: row.wp_author_id,
    wp_category_ids: pgJson(row.wp_category_ids),
    wp_tag_ids: pgJson(row.wp_tag_ids),
    wp_featured_media_id: row.wp_featured_media_id,
    wp_slug: row.wp_slug,
    wp_excerpt: row.wp_excerpt,
    wp_pushed_post_id: row.wp_pushed_post_id,
    wp_pushed_at: pgTimestampToIso(row.wp_pushed_at),
    wp_push_error: pgJson(row.wp_push_error),
    start_mode: row.start_mode,
    topic_candidate_id: row.topic_candidate_id,
    target_audience: row.target_audience,
    error: pgJson(row.error),
  };
}

function normalizeStartMode(raw: string | undefined): StartMode {
  return raw === "create" ? "create" : "refresh";
}

/** Stringify a `date_gmt` value the way the Python route does: `YYYY-MM-DDTHH:mm:ss` in UTC. */
function toDateGmt(iso: string): string {
  // Parse the provided instant and re-emit as UTC without the trailing Z.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso.replace(/Z$|[+-]\d{2}:\d{2}$/, "");
  }
  return d.toISOString().replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const runsRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// ---------------------------------------------------------------------------
// POST / — create a run
// ---------------------------------------------------------------------------
runsRouter.post("/", requireRole("editor"), async (c) => {
  const body = await c.req
    .json<CreateRunBody>()
    .catch(() => ({}) as CreateRunBody);

  const startMode = normalizeStartMode(body.start_mode);
  const articleUrl = body.article_url ?? null;

  // Validation parity with CreateRunRequest validators:
  //   create  → article_url MUST be null
  //   refresh → article_url is REQUIRED
  if (startMode === "create" && articleUrl !== null) {
    return c.json({ detail: "create runs must not supply article_url" }, 422);
  }
  if (startMode === "refresh" && (articleUrl === null || articleUrl === "")) {
    return c.json({ detail: "refresh runs require article_url" }, 422);
  }

  const runId = crypto.randomUUID();
  const topic = body.topic ?? "";
  const keywords = body.keywords ?? [];
  const mode = body.mode ?? "auto";
  const persona = body.persona ?? "bowtie-editor";
  const acfAdvId = body.acf_adv_id ?? 0;
  const acfWidgetId = body.acf_widget_id ?? 0;
  // Audit identity: bind `created_by` to the authenticated session, ignoring any
  // client-supplied `editor_email` when a session is present (see ./identity).
  const createdBy = resolveActorIdentity(
    { userEmail: c.get("userEmail"), userId: c.get("userId") },
    body.editor_email,
  );
  const topicCategory = body.topic_category ?? null;
  const editNote = body.edit_note ?? null;
  const topicCandidateId = body.topic_candidate_id ?? null;
  const targetAudience = body.target_audience ?? null;
  const triggeredByEvaluationId = body.triggered_by_evaluation_id ?? null;

  const created = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<{ run_id: string; created_at: string; article_id: string | null }[]>`
      INSERT INTO content_tool.runs (
        run_id, created_by, status, article_url, topic, keywords, mode,
        edit_note, acf_adv_id, acf_widget_id, persona, topic_category,
        today_date, start_mode, topic_candidate_id, target_audience,
        triggered_by_evaluation_id
      ) VALUES (
        ${runId}, ${createdBy}, 'pending', ${articleUrl}, ${topic},
        ${toJsonb(sql, keywords)}, ${mode}, ${editNote}, ${acfAdvId}, ${acfWidgetId},
        ${persona}, ${topicCategory}, CURRENT_DATE, ${startMode},
        ${topicCandidateId}, ${targetAudience}, ${triggeredByEvaluationId}
      )
      RETURNING run_id, created_at, article_id
    `;
    return rows[0] ?? null;
  });

  if (created === null) {
    return c.json({ detail: "failed to create run" }, 500);
  }

  // Both modes kick the same PRODUCTION workflow; it branches on run.start_mode
  // (create → outline; refresh → fetch_article → gap_analysis → outline). The
  // run-id IS the workflow instance id so the resume routes can address it.
  const env = c.env as RunsEnv;
  await env.PRODUCTION.create({ id: runId, params: { runId } });

  return c.json({
    run_id: created.run_id,
    status: "pending",
    created_at: pgTimestampToIso(created.created_at),
    article_id: created.article_id,
  });
});

// ---------------------------------------------------------------------------
// GET / — list runs
// ---------------------------------------------------------------------------
runsRouter.get("/", async (c) => {
  const statusFilter = c.req.query("status") ?? null;
  const limitRaw = parseInt(c.req.query("limit") ?? String(DEFAULT_LIST_LIMIT), 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(limitRaw, 1) : DEFAULT_LIST_LIMIT;

  const rows = await withDb(c.env, c.executionCtx, (sql: Sql) => {
    const statusClause =
      statusFilter !== null ? sql`WHERE status = ${statusFilter}` : sql``;
    return sql<RunListRow[]>`
      SELECT
        run_id, status, topic, article_url, mode, created_at, chosen_route,
        iteration_count, start_mode, target_audience, keywords, persona,
        acf_adv_id, acf_widget_id, edit_note
      FROM content_tool.runs
      ${statusClause}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  });

  return c.json(
    rows.map((r) => ({
      run_id: r.run_id,
      status: r.status,
      topic: r.topic,
      article_url: r.article_url,
      mode: r.mode,
      created_at: pgTimestampToIso(r.created_at),
      chosen_route: r.chosen_route,
      iteration_count: r.iteration_count,
      start_mode: r.start_mode,
      target_audience: r.target_audience,
      keywords: pgJson(r.keywords),
      persona: r.persona,
      acf_adv_id: r.acf_adv_id,
      acf_widget_id: r.acf_widget_id,
      edit_note: r.edit_note,
    })),
  );
});

// ---------------------------------------------------------------------------
// GET /:id — run detail (RunSummary)
// ---------------------------------------------------------------------------
runsRouter.get("/:id", async (c) => {
  const runId = c.req.param("id");

  const row = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<RunDetailRow[]>`
      SELECT
        run_id, status, topic, article_url, mode, keywords, persona,
        acf_adv_id, acf_widget_id, edit_note, chosen_route, iteration_count,
        created_at, updated_at, created_by, approved_at, approved_by,
        hitl_2_decision, hitl_2_notes, hitl_2_iteration, wp_publish_status,
        wp_author_id, wp_category_ids, wp_tag_ids, wp_featured_media_id,
        wp_slug, wp_excerpt,
        wp_pushed_post_id, wp_pushed_at, wp_push_error, start_mode,
        topic_candidate_id, target_audience, error
      FROM content_tool.runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  });

  if (row === null) {
    return c.json({ detail: "run not found" }, 404);
  }
  return c.json(toRunSummary(row));
});

// ---------------------------------------------------------------------------
// POST /:id/restart — re-run a failed run
//
// Only `failed` runs are restartable; an in-flight or completed run must not
// have its workflow replayed out from under it. We replay the SAME workflow
// instance via `instance.restart()`, which keeps the instance id == runId so
// the HITL resume routes (`get(runId).sendEvent`) keep addressing it. Cloudflare
// Workflows resumes from the last checkpointed step, so a run that died in the
// publish step re-runs only the tail — earlier durable steps are not repeated.
// Mirrors the Python `restart_run` handler (content_tool/api/routes/runs.py).
//
// The status flip to `pending` is an ATOMIC claim (UPDATE … WHERE status =
// 'failed') so two concurrent restart requests cannot both fire `restart()`,
// and it is REVERTED back to `failed` if the workflow call throws — otherwise a
// transient Workflows error would strand the run at `pending`, where the guard
// would refuse any further restart.
// ---------------------------------------------------------------------------
runsRouter.post("/:id/restart", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");

  const claim = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const claimed = await sql<{ run_id: string }[]>`
      UPDATE content_tool.runs
      SET status = 'pending', error = NULL
      WHERE run_id = ${runId} AND status = 'failed'
      RETURNING run_id
    `;
    if (claimed.length > 0) return { ok: true as const };
    // Lost the claim — the row is missing (404) or not in `failed` state (409;
    // also covers an already-claimed concurrent restart, now `pending`).
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
    `;
    const verdict = restartGuard(rows[0]);
    return "error" in verdict ? verdict : { error: "not_failed" as const };
  });

  if ("error" in claim) {
    if (claim.error === "not_found") {
      return c.json({ detail: "run not found" }, 404);
    }
    return c.json({ detail: "only failed runs can be restarted" }, 409);
  }

  const env = c.env as RunsEnv;
  try {
    const instance = await env.PRODUCTION.get(runId);
    await instance.restart();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    // Compensate: hand the run back to `failed` so the operator can retry.
    await withDb(c.env, c.executionCtx, async (sql: Sql) => {
      await sql`
        UPDATE content_tool.runs
        SET status = 'failed',
            error = ${toJsonb(sql, { type: "restart_error", message })}
        WHERE run_id = ${runId}
      `;
    });
    return c.json({ detail: `failed to restart workflow: ${message}` }, 502);
  }

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /:id/resume — HITL_1 decision
// ---------------------------------------------------------------------------
runsRouter.post("/:id/resume", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");
  const body = await c.req.json<ResumeBody>().catch(() => ({}) as ResumeBody);
  const decision = body.decision ?? "approve";

  const guard = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
    `;
    if (rows[0] === undefined) {
      return { error: "not_found" as const };
    }

    // Atomic gate claim (matches /hitl-2 + the version-guard style): the run must
    // be PAUSED at the HITL_1 gate. The workflow sets status = 'hitl_1' right
    // before `step.waitForEvent("await-hitl1")`, so this rejects a stale-tab
    // decision and single-flights the sendEvent — only the request that flips the
    // status away from the gate proceeds. `result.count === 0` → 409.
    const claim = await sql`
      UPDATE content_tool.runs
      SET hitl_1_decision = ${decision}, hitl_1_notes = ${body.notes ?? null}
      WHERE run_id = ${runId} AND status = ${HITL_1_GATE_STATUS}
    `;
    if (claim.count === 0) {
      return { error: "not_at_gate" as const };
    }

    // Only apply the side-effect edits once the gate is ours, so a losing
    // concurrent request cannot clobber the outline / route of a run that has
    // already moved on.
    if (decision === "edit_outline" && body.edited_outline !== undefined) {
      await sql`
        UPDATE content_tool.outlines
        SET edited_by_human = TRUE, human_edits = ${toJsonb(sql, body.edited_outline ?? null)}
        WHERE run_id = ${runId}
      `;
    }
    if (decision === "override_route" && body.new_route) {
      await sql`
        UPDATE content_tool.runs
        SET chosen_route = ${body.new_route}
        WHERE run_id = ${runId}
      `;
    }
    return { ok: true as const };
  });

  if ("error" in guard) {
    if (guard.error === "not_found") {
      return c.json({ detail: "run not found" }, 404);
    }
    return c.json({ detail: "run is not awaiting a HITL_1 decision" }, 409);
  }

  const env = c.env as RunsEnv;
  const instance = await env.PRODUCTION.get(runId);
  await instance.sendEvent({
    type: "hitl_1",
    payload: {
      decision,
      edited_outline: body.edited_outline ?? null,
      new_route: body.new_route ?? null,
      notes: body.notes ?? null,
    },
  });

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /:id/hitl-2 — HITL_2 decision
// ---------------------------------------------------------------------------
runsRouter.post("/:id/hitl-2", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");
  const body = await c.req.json<Hitl2Body>().catch(() => ({}) as Hitl2Body);
  const decision = body.decision ?? "approve";
  const comments = body.comments ?? [];
  // Compliance record-of-truth: the authenticated session identity (NOT the
  // client-supplied payload). Falls back to the payload only on the AUTH_DISABLED
  // dev path where no session exists, then to "unknown" (see ./identity).
  const editorEmail = resolveActorIdentity(
    { userEmail: c.get("userEmail"), userId: c.get("userId") },
    body.editor_email,
  );

  const guard = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<RunHitl2StateRow[]>`
      SELECT status, hitl_2_iteration FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
    `;
    const current = rows[0];
    if (current === undefined) {
      return { error: "not_found" as const };
    }

    // Atomic claim of the HITL_2 decision (optimistic-concurrency, matches the
    // PUT /article + /outline version-guard style). Two guards are folded into
    // the WHERE clause so the read-then-write TOCTOU windows close:
    //
    //  - status = 'awaiting_hitl_2': the run must actually be PAUSED at the
    //    HITL_2 gate. The workflow sets this exact status right before
    //    `step.waitForEvent("await-hitl2-*")`, so this both rejects a stale tab
    //    that posts after the gate moved on AND single-flights the sendEvent —
    //    only the request that flips the status away from the gate proceeds to
    //    `instance.sendEvent`. (Defense in depth: Cloudflare Workflows already
    //    delivers one waitForEvent per gate; this stops a second decision from
    //    racing in before the first wakes the workflow.)
    //  - hitl_2_iteration < MAX (request_changes only): two concurrent
    //    `request_changes` cannot both pass the cap — the bound lives IN the
    //    conditional UPDATE, not in a separate read-then-check.
    //
    // `result.count` is the affected-row count; 0 means a guard rejected the
    // write. The pre-SELECT above lets us tell 404 (no row) from 409 (a guard
    // matched no row) and pick the precise 409 reason.
    //
    // request_changes → increment, guarded by status + cap.
    // approve / reject → leave the counter untouched (no cap applies).
    const newIteration = sql`hitl_2_iteration${
      decision === "request_changes" ? sql` + 1` : sql``
    }`;
    const capGuard =
      decision === "request_changes"
        ? sql`AND hitl_2_iteration < ${HITL_2_MAX_ITERATIONS}`
        : sql``;

    const result = await sql`
      UPDATE content_tool.runs SET
        hitl_2_decision = ${decision},
        hitl_2_notes = ${body.notes ?? null},
        hitl_2_comments = ${toJsonb(sql, comments)},
        hitl_2_iteration = ${newIteration},
        approved_at = ${decision === "approve" ? sql`now()` : null},
        approved_by = ${decision === "approve" ? editorEmail : null},
        wp_publish_status = ${body.wp_publish_status ?? null},
        wp_author_id = ${body.wp_author_id ?? null},
        wp_category_ids = ${body.wp_category_ids == null ? null : toJsonb(sql, body.wp_category_ids)},
        wp_tag_ids = ${body.wp_tag_ids == null ? null : toJsonb(sql, body.wp_tag_ids)},
        wp_featured_media_id = ${body.wp_featured_media_id ?? null},
        wp_slug = ${body.wp_slug ?? null},
        wp_excerpt = ${body.wp_excerpt ?? null},
        wp_publish_at = ${body.wp_publish_at ?? null}
      WHERE run_id = ${runId}
        AND status = ${HITL_2_GATE_STATUS} ${capGuard}
    `;
    if (result.count === 0) {
      // The row exists (checked above) but the conditional WHERE matched nothing.
      // Disambiguate: a `request_changes` that is at the gate but over the cap is
      // a cap rejection; anything else is the run not being paused at HITL_2.
      if (
        decision === "request_changes" &&
        current.status === HITL_2_GATE_STATUS &&
        current.hitl_2_iteration >= HITL_2_MAX_ITERATIONS
      ) {
        return { error: "cap_reached" as const };
      }
      return { error: "not_at_gate" as const };
    }

    // Persist human inline edits onto the latest render BEFORE sendEvent so the
    // workflow's publish step pushes the reviewer's edited content (mirrors
    // PUT /article). Only on approve — request_changes triggers an AI rewrite
    // and reject is terminal. COALESCE preserves fields the caller omitted.
    if (decision === "approve") {
      const renderRows = await sql<{ render_id: string }[]>`
        SELECT r.render_id
        FROM content_tool.renders r
        JOIN content_tool.drafts d ON d.draft_id = r.draft_id
        WHERE d.run_id = ${runId}
        ORDER BY d.iteration DESC
        LIMIT 1
      `;
      const render = renderRows[0];
      if (render !== undefined) {
        await sql`
          UPDATE content_tool.renders
          SET html_body = COALESCE(${body.edited_html_body ?? null}, html_body),
              seo_title = COALESCE(${body.edited_seo_title ?? null}, seo_title),
              meta_description = COALESCE(${body.edited_meta_description ?? null}, meta_description)
          WHERE render_id = ${render.render_id}
        `;
      }
    }
    return { ok: true as const };
  });

  if ("error" in guard) {
    if (guard.error === "not_found") {
      return c.json({ detail: "run not found" }, 404);
    }
    if (guard.error === "cap_reached") {
      return c.json({ detail: "request_changes cap reached" }, 409);
    }
    // not_at_gate — the run is not paused at HITL_2 (already decided, or a
    // concurrent request already claimed the gate).
    return c.json({ detail: "run is not awaiting a HITL_2 decision" }, 409);
  }

  const env = c.env as RunsEnv;
  const instance = await env.PRODUCTION.get(runId);
  await instance.sendEvent({
    type: "hitl_2",
    payload: {
      decision,
      notes: body.notes ?? null,
      comments,
      edited_html_body: body.edited_html_body ?? null,
      edited_seo_title: body.edited_seo_title ?? null,
      edited_meta_description: body.edited_meta_description ?? null,
      wp_publish_status: body.wp_publish_status ?? null,
      wp_author_id: body.wp_author_id ?? null,
      wp_category_ids: body.wp_category_ids ?? null,
      wp_tag_ids: body.wp_tag_ids ?? null,
      wp_featured_media_id: body.wp_featured_media_id ?? null,
      wp_slug: body.wp_slug ?? null,
      wp_excerpt: body.wp_excerpt ?? null,
      wp_publish_at: body.wp_publish_at ?? null,
    },
  });

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /:id/events — SSE proxy to the RUN_STREAM Durable Object.
// The browser opens this stream cross-origin (Next rewrites buffer SSE), so the
// response carries CORS headers pinned by FRONTEND_ORIGIN.
// ---------------------------------------------------------------------------
runsRouter.get("/:id/events", async (c) => {
  const runId = c.req.param("id");
  const stub = c.env.RUN_STREAM.get(c.env.RUN_STREAM.idFromName(runId));
  const res = await stub.fetch("https://run-stream/events");
  const origin = resolveCorsOrigin(c.req.header("origin") ?? null, c.env.FRONTEND_ORIGIN);
  return withCors(res, origin);
});

runsRouter.options("/:id/events", (c) =>
  corsPreflight(resolveCorsOrigin(c.req.header("origin") ?? null, c.env.FRONTEND_ORIGIN)),
);

// ---------------------------------------------------------------------------
// POST /:id/dry-publish — preview the WP REST payload WITHOUT calling WP
// ---------------------------------------------------------------------------
runsRouter.post("/:id/dry-publish", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");
  const ov = await c.req
    .json<DryPublishBody>()
    .catch(() => ({}) as DryPublishBody);

  const data = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const runRows = await sql<RunDryPublishRow[]>`
      SELECT
        start_mode, wp_publish_status, wp_category_ids, wp_tag_ids, wp_excerpt,
        wp_slug, wp_author_id, wp_featured_media_id, wp_publish_at, wp_pushed_post_id
      FROM content_tool.runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    const run = runRows[0];
    if (run === undefined) {
      return null;
    }

    // Refresh updates the existing WP post. When this run hasn't pushed yet,
    // the target id comes from the fetched_articles row (mirrors Python
    // dry-publish: `wp_post_id = fa.wp_post_id`). Create has no such row.
    let fetchedPostId: number | null = null;
    if (run.start_mode === "refresh" && run.wp_pushed_post_id === null) {
      const faRows = await sql<{ wp_post_id: number | null }[]>`
        SELECT wp_post_id FROM content_tool.fetched_articles
        WHERE run_id = ${runId} LIMIT 1
      `;
      fetchedPostId = faRows[0]?.wp_post_id ?? null;
    }

    const renderRows = await sql<RenderDryPublishRow[]>`
      SELECT
        r.seo_title, r.meta_description, r.html_body, r.excerpt_suggestion,
        r.slug_suggestion, r.schema_jsonld
      FROM content_tool.renders r
      JOIN content_tool.drafts d ON d.draft_id = r.draft_id
      WHERE d.run_id = ${runId}
      ORDER BY d.iteration DESC
      LIMIT 1
    `;
    const render = renderRows[0] ?? null;
    return { run, render, fetchedPostId };
  });

  if (data === null) {
    return c.json({ detail: "run not found" }, 404);
  }
  if (data.render === null) {
    return c.json({ detail: "no render for this run" }, 404);
  }

  const { run, render, fetchedPostId } = data;
  // Effective WP post id: a prior push wins, else the refresh fetched-post id
  // (null for an un-pushed create → POST a new draft).
  const effectivePostId = run.wp_pushed_post_id ?? fetchedPostId;

  // Merge optional reviewer edits over the persisted render + run WP options.
  const title = ov.edited_seo_title ?? render.seo_title;
  const content = ov.edited_html_body ?? render.html_body;
  const metaDesc = ov.edited_meta_description ?? render.meta_description;
  const status = resolvePublishStatus(ov.wp_publish_status ?? run.wp_publish_status);
  const categories = ov.wp_category_ids ?? pgJson<number[] | null>(run.wp_category_ids) ?? [];
  const tags = ov.wp_tag_ids ?? pgJson<number[] | null>(run.wp_tag_ids) ?? [];
  const excerpt = ov.wp_excerpt ?? run.wp_excerpt ?? render.excerpt_suggestion;
  const slug = ov.wp_slug ?? run.wp_slug;
  const author = ov.wp_author_id ?? run.wp_author_id;
  const featuredMedia = ov.wp_featured_media_id ?? run.wp_featured_media_id;
  const publishAt = ov.wp_publish_at ?? run.wp_publish_at;

  // SEO plugin detection is best-effort: dry-publish must never fail just
  // because WP is unreachable. Fall back to no SEO description key.
  let seoPlugin: Awaited<ReturnType<typeof detectSeoPlugin>> = null;
  if (c.env.WP_BASE_URL) {
    try {
      seoPlugin = await detectSeoPlugin(c.env);
    } catch {
      seoPlugin = null;
    }
  }

  const schemaJsonld =
    render.schema_jsonld !== null && render.schema_jsonld !== undefined
      ? pgJson<object[]>(render.schema_jsonld)
      : null;
  const meta = buildMeta(metaDesc, schemaJsonld, seoPlugin);

  const requestBody: Record<string, unknown> = {
    title,
    content,
    status,
    categories,
    tags,
    meta,
    template: WP_DEFAULT_PAGE_TEMPLATE,
  };
  if (excerpt) {
    requestBody.excerpt = excerpt;
  }
  if (slug) {
    requestBody.slug = slug;
  }
  if (author) {
    requestBody.author = author;
  }
  if (featuredMedia) {
    requestBody.featured_media = featuredMedia;
  }
  if (publishAt) {
    requestBody.date_gmt = toDateGmt(pgTimestampToIso(publishAt) ?? publishAt);
  }

  const targetBase = c.env.WP_BASE_URL ?? "";
  const baseTrimmed = targetBase.replace(/\/$/, "");
  const method = effectivePostId ? "PUT" : "POST";
  const url = effectivePostId
    ? `${baseTrimmed}/wp-json/wp/v2/posts/${effectivePostId}`
    : `${baseTrimmed}/wp-json/wp/v2/posts`;

  return c.json({
    target_base_url: c.env.WP_BASE_URL ?? null,
    target_label: c.env.WP_TARGET ?? null,
    request_method: method,
    request_url: url,
    request_headers: {
      authorization: "Basic <redacted>",
      "content-type": "application/json",
    },
    request_body: requestBody,
  });
});

// ---------------------------------------------------------------------------
// GET /:id/gap-analysis — latest gap analysis payload
// ---------------------------------------------------------------------------
runsRouter.get("/:id/gap-analysis", async (c) => {
  const runId = c.req.param("id");
  const payload = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<{ payload: unknown }[]>`
      SELECT payload FROM content_tool.gap_analyses
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
  if (payload === null) {
    return c.json({ detail: "not found" }, 404);
  }
  return c.json(pgJson(payload.payload));
});

// ---------------------------------------------------------------------------
// GET /:id/outline — outline payload + human-edit metadata
// ---------------------------------------------------------------------------
runsRouter.get("/:id/outline", async (c) => {
  const runId = c.req.param("id");
  const row = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<
      { payload: unknown; edited_by_human: boolean; human_edits: unknown; version: number }[]
    >`
      SELECT payload, edited_by_human, human_edits, version
      FROM content_tool.outlines
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
  if (row === null) {
    return c.json({ detail: "not found" }, 404);
  }
  return c.json({
    payload: pgJson(row.payload),
    edited_by_human: row.edited_by_human,
    human_edits: pgJson(row.human_edits),
    // Optimistic-concurrency token — echo back as `expected_version` on
    // PUT /outline so a stale edit is rejected instead of clobbering.
    version: row.version,
  });
});

// ---------------------------------------------------------------------------
// GET /:id/drafts/latest — latest draft
// ---------------------------------------------------------------------------
runsRouter.get("/:id/drafts/latest", async (c) => {
  const runId = c.req.param("id");
  const row = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<
      {
        draft_id: string;
        iteration: number;
        diagnose: string;
        markup_raw: string;
        final_markup: string | null;
      }[]
    >`
      SELECT draft_id, iteration, diagnose, markup_raw, final_markup
      FROM content_tool.drafts
      WHERE run_id = ${runId}
      ORDER BY iteration DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
  if (row === null) {
    return c.json({ detail: "not found" }, 404);
  }
  return c.json({
    draft_id: row.draft_id,
    iteration: row.iteration,
    diagnose: row.diagnose,
    markup_raw: row.markup_raw,
    final_markup: row.final_markup,
  });
});

// ---------------------------------------------------------------------------
// GET /:id/render — latest render
// ---------------------------------------------------------------------------
runsRouter.get("/:id/render", async (c) => {
  const runId = c.req.param("id");
  const row = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<
      {
        seo_title: string;
        meta_description: string;
        html_body: string;
        faq_schema_jsonld: unknown;
        schema_jsonld: unknown;
        excerpt_suggestion: string | null;
        slug_suggestion: string | null;
        version: number;
      }[]
    >`
      SELECT
        r.seo_title, r.meta_description, r.html_body, r.faq_schema_jsonld,
        r.schema_jsonld, r.excerpt_suggestion, r.slug_suggestion, r.version
      FROM content_tool.renders r
      JOIN content_tool.drafts d ON d.draft_id = r.draft_id
      WHERE d.run_id = ${runId}
      ORDER BY d.iteration DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
  if (row === null) {
    return c.json({ detail: "no render" }, 404);
  }
  return c.json({
    seo_title: row.seo_title,
    meta_description: row.meta_description,
    html_body: row.html_body,
    faq_schema_jsonld: pgJson(row.faq_schema_jsonld),
    schema_jsonld: pgJson(row.schema_jsonld),
    excerpt_suggestion: row.excerpt_suggestion,
    slug_suggestion: row.slug_suggestion,
    // Optimistic-concurrency token — echo back as `expected_version` on
    // PUT /article so a stale edit is rejected instead of clobbering.
    version: row.version,
  });
});

// ---------------------------------------------------------------------------
// GET /:id/audit — latest audit for the run's latest draft
// ---------------------------------------------------------------------------
runsRouter.get("/:id/audit", async (c) => {
  const runId = c.req.param("id");
  const row = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<
      {
        overall_pass: boolean;
        severity_high: number;
        severity_medium: number;
        severity_low: number;
        llm_findings: unknown;
        deterministic_findings: unknown;
      }[]
    >`
      SELECT
        a.overall_pass, a.severity_high, a.severity_medium, a.severity_low,
        a.llm_findings, a.deterministic_findings
      FROM content_tool.audit_runs a
      JOIN content_tool.drafts d ON d.draft_id = a.draft_id
      WHERE d.run_id = ${runId}
      ORDER BY d.iteration DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
  if (row === null) {
    return c.json({ detail: "no audit" }, 404);
  }
  return c.json({
    overall_pass: row.overall_pass,
    severity_high: row.severity_high,
    severity_medium: row.severity_medium,
    severity_low: row.severity_low,
    llm_findings: pgJson(row.llm_findings),
    deterministic_findings: pgJson(row.deterministic_findings),
  });
});

// ---------------------------------------------------------------------------
// Post-hoc edit / republish / snapshot routes — mirror content_tool/api/routes/runs.py
// These are plain DB/WP operations on finished runs; they never touch the
// LangGraph workflow checkpoint (unlike /resume and /hitl-2).
// ---------------------------------------------------------------------------

// How many autosave / version-history snapshots to retain per run.
const HITL2_SNAPSHOT_KEEP = 50;

interface Hitl2SnapshotBody {
  trigger?: "interval" | "navigate" | "unload" | "manual";
  html_body?: string;
  seo_title?: string | null;
  meta_description?: string | null;
  notes?: string | null;
  comments?: Hitl2Comment[] | null;
  wp_publish_status?: string | null;
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  wp_publish_at?: string | null;
}

interface Hitl2SnapshotRow {
  snapshot_id: string;
  run_id: string;
  created_at: string;
  created_by: string | null;
  trigger: string;
  html_body: string;
  seo_title: string | null;
  meta_description: string | null;
  notes: string | null;
  comments: unknown;
  wp_publish_status: string | null;
  wp_author_id: number | null;
  wp_category_ids: unknown;
  wp_tag_ids: unknown;
  wp_featured_media_id: number | null;
  wp_slug: string | null;
  wp_excerpt: string | null;
  wp_publish_at: string | null;
}

interface OutlineEditBody {
  outline?: unknown;
  expected_version?: number | null;
}

interface ArticleEditBody {
  html_body?: string;
  seo_title?: string;
  meta_description?: string;
  wp_publish_status?: string | null;
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  wp_publish_at?: string | null;
  expected_version?: number | null;
}

interface ApplyEditsBody {
  html_body?: string;
  comments?: Array<{ anchor_text?: string; body?: string }> | null;
  notes?: string | null;
}

interface RepublishRunRow {
  start_mode: string;
  created_by: string | null;
  wp_pushed_post_id: number | null;
  wp_publish_status: string | null;
  wp_author_id: number | null;
  wp_category_ids: unknown;
  wp_tag_ids: unknown;
  wp_featured_media_id: number | null;
  wp_slug: string | null;
  wp_excerpt: string | null;
}

interface RepublishRenderRow {
  seo_title: string;
  meta_description: string;
  html_body: string;
  excerpt_suggestion: string | null;
  schema_jsonld: unknown;
}

/** Coerce a jsonb array column into number[] (ids), dropping non-numbers. */
function toNumberArray(value: unknown): number[] {
  const arr = pgJson<unknown>(value);
  if (!Array.isArray(arr)) {
    return [];
  }
  return arr.map((v) => Number(v)).filter((n) => Number.isFinite(n));
}

/** Serialize a hitl2_snapshots row into the API output shape (timestamps→ISO, jsonb→native). */
function toSnapshotOut(row: Hitl2SnapshotRow): Record<string, unknown> {
  return {
    snapshot_id: row.snapshot_id,
    run_id: row.run_id,
    created_at: pgTimestampToIso(row.created_at),
    created_by: row.created_by,
    trigger: row.trigger,
    html_body: row.html_body,
    seo_title: row.seo_title,
    meta_description: row.meta_description,
    notes: row.notes,
    comments: pgJson(row.comments),
    wp_publish_status: row.wp_publish_status,
    wp_author_id: row.wp_author_id,
    wp_category_ids: pgJson(row.wp_category_ids),
    wp_tag_ids: pgJson(row.wp_tag_ids),
    wp_featured_media_id: row.wp_featured_media_id,
    wp_slug: row.wp_slug,
    wp_excerpt: row.wp_excerpt,
    wp_publish_at: pgTimestampToIso(row.wp_publish_at),
  };
}

/**
 * Best-effort resolution of WP author / category display names. Any upstream
 * failure (WP unreachable, not configured, 404) collapses to null so the UI
 * falls back to the raw id. Mirrors `_resolve_wp_names` in the Python route.
 */
async function resolveWpNames(
  env: Env,
  authorId: number | null,
  categoryId: number | null,
): Promise<[string | null, string | null]> {
  let client: WordPressClient;
  try {
    client = new WordPressClient(env);
  } catch {
    return [null, null];
  }
  const authorName =
    authorId === null
      ? null
      : await client
          .getUser(authorId)
          .then((u) => u?.name ?? null)
          .catch(() => null);
  const categoryName =
    categoryId === null
      ? null
      : await client
          .getCategory(categoryId)
          .then((cat) => cat?.name ?? null)
          .catch(() => null);
  return [authorName, categoryName];
}

// ---------------------------------------------------------------------------
// GET /:id/existing-post — cached snapshot of the existing WP post (prefill)
// ---------------------------------------------------------------------------
runsRouter.get("/:id/existing-post", async (c) => {
  const runId = c.req.param("id");
  const fa = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<
      {
        wp_post_id: number | null;
        wp_link: string | null;
        wp_author_id: number | null;
        wp_categories: unknown;
        wp_slug: string | null;
      }[]
    >`
      SELECT wp_post_id, wp_link, wp_author_id, wp_categories, wp_slug
      FROM content_tool.fetched_articles
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  });

  if (fa === null || fa.wp_post_id === null) {
    return c.json({ detail: "No existing post" }, 404);
  }

  const cats = pgJson<Array<{ id?: number }> | null>(fa.wp_categories);
  const firstCatId =
    Array.isArray(cats) && cats[0] && typeof cats[0] === "object" && "id" in cats[0]
      ? (cats[0].id ?? null)
      : null;

  const [authorName, categoryName] = await resolveWpNames(
    c.env,
    fa.wp_author_id,
    firstCatId,
  );

  return c.json({
    wp_post_id: fa.wp_post_id,
    link: fa.wp_link,
    wp_author_id: fa.wp_author_id,
    wp_author_name: authorName,
    wp_category_id: firstCatId,
    wp_category_name: categoryName,
    wp_slug: fa.wp_slug,
  });
});

// ---------------------------------------------------------------------------
// POST /:id/existing-post/refresh — re-read the post from WP, update the cache
// ---------------------------------------------------------------------------
runsRouter.post("/:id/existing-post/refresh", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");

  const run = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<{ article_url: string | null }[]>`
      SELECT article_url FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
    `;
    return rows[0] ?? null;
  });
  if (run === null) {
    return c.json({ detail: "Run not found" }, 404);
  }
  if (!run.article_url) {
    return c.json({ detail: "Existing post not found on WordPress" }, 404);
  }

  let client: WordPressClient;
  try {
    client = new WordPressClient(c.env);
  } catch {
    return c.json({ detail: "WordPress client not configured" }, 503);
  }

  let post: Awaited<ReturnType<WordPressClient["fetchPostByUrl"]>>;
  try {
    post = await client.fetchPostByUrl(run.article_url);
  } catch (e: unknown) {
    if (e instanceof WordPressError) {
      return c.json({ detail: "WordPress upstream error" }, 502);
    }
    throw e;
  }
  if (post === null) {
    return c.json({ detail: "Existing post not found on WordPress" }, 404);
  }

  const found = post;
  const updated = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const faRows = await sql<{ run_id: string }[]>`
      SELECT run_id FROM content_tool.fetched_articles WHERE run_id = ${runId} LIMIT 1
    `;
    if (faRows[0] === undefined) {
      return false;
    }
    const categories = found.categories.map((cid) => ({ id: cid }));
    await sql`
      UPDATE content_tool.fetched_articles
      SET wp_categories = ${toJsonb(sql, categories)},
          wp_author_id = ${found.author},
          wp_slug = ${found.slug},
          wp_link = ${found.link}
      WHERE run_id = ${runId}
    `;
    return true;
  });
  if (!updated) {
    return c.json({ detail: "No fetched article for this run" }, 404);
  }

  const firstCatId = found.categories.length > 0 ? found.categories[0]! : null;
  const [authorName, categoryName] = await resolveWpNames(
    c.env,
    found.author,
    firstCatId,
  );
  return c.json({
    wp_post_id: found.id,
    link: found.link,
    wp_author_id: found.author,
    wp_author_name: authorName,
    wp_category_id: firstCatId,
    wp_category_name: categoryName,
    wp_slug: found.slug,
  });
});

// ---------------------------------------------------------------------------
// POST /:id/hitl2-snapshots — persist one autosave / version-history snapshot
// ---------------------------------------------------------------------------
runsRouter.post("/:id/hitl2-snapshots", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");
  const body = await c.req
    .json<Hitl2SnapshotBody>()
    .catch(() => ({}) as Hitl2SnapshotBody);
  // Audit identity: bind `created_by` to the authenticated session (email →
  // userId → "unknown"), consistent with the create-run / hitl-2 sites. The
  // snapshot body carries no `editor_email`, so the payload fallback is null.
  const editorEmail = resolveActorIdentity(
    { userEmail: c.get("userEmail"), userId: c.get("userId") },
    null,
  );

  const result = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const runRows = await sql<{ run_id: string }[]>`
      SELECT run_id FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
    `;
    if (runRows[0] === undefined) {
      return { error: "not_found" as const };
    }

    const snapshotId = crypto.randomUUID();
    const comments = body.comments ?? null;
    const rows = await sql<Hitl2SnapshotRow[]>`
      INSERT INTO content_tool.hitl2_snapshots (
        snapshot_id, run_id, created_by, trigger, html_body, seo_title,
        meta_description, notes, comments, wp_publish_status, wp_author_id,
        wp_category_ids, wp_tag_ids, wp_featured_media_id, wp_slug, wp_excerpt,
        wp_publish_at
      ) VALUES (
        ${snapshotId}, ${runId}, ${editorEmail}, ${body.trigger ?? "manual"},
        ${body.html_body ?? ""}, ${body.seo_title ?? null}, ${body.meta_description ?? null},
        ${body.notes ?? null}, ${comments === null ? null : toJsonb(sql, comments)},
        ${body.wp_publish_status ?? null}, ${body.wp_author_id ?? null},
        ${body.wp_category_ids == null ? null : toJsonb(sql, body.wp_category_ids)},
        ${body.wp_tag_ids == null ? null : toJsonb(sql, body.wp_tag_ids)},
        ${body.wp_featured_media_id ?? null}, ${body.wp_slug ?? null},
        ${body.wp_excerpt ?? null}, ${body.wp_publish_at ?? null}
      )
      RETURNING
        snapshot_id, run_id, created_at, created_by, trigger, html_body,
        seo_title, meta_description, notes, comments, wp_publish_status,
        wp_author_id, wp_category_ids, wp_tag_ids, wp_featured_media_id,
        wp_slug, wp_excerpt, wp_publish_at
    `;

    // Prune to the newest HITL2_SNAPSHOT_KEEP rows so history stays bounded.
    await sql`
      DELETE FROM content_tool.hitl2_snapshots
      WHERE snapshot_id IN (
        SELECT snapshot_id FROM content_tool.hitl2_snapshots
        WHERE run_id = ${runId}
        ORDER BY created_at DESC
        OFFSET ${HITL2_SNAPSHOT_KEEP}
      )
    `;
    return { snap: rows[0] ?? null };
  });

  if ("error" in result) {
    return c.json({ detail: "run not found" }, 404);
  }
  if (result.snap === null) {
    return c.json({ detail: "failed to save snapshot" }, 500);
  }
  return c.json(toSnapshotOut(result.snap));
});

// ---------------------------------------------------------------------------
// GET /:id/hitl2-snapshots — list snapshots newest-first (version history)
// ---------------------------------------------------------------------------
runsRouter.get("/:id/hitl2-snapshots", async (c) => {
  const runId = c.req.param("id");
  const rows = await withDb(c.env, c.executionCtx, (sql: Sql) =>
    sql<Hitl2SnapshotRow[]>`
      SELECT
        snapshot_id, run_id, created_at, created_by, trigger, html_body,
        seo_title, meta_description, notes, comments, wp_publish_status,
        wp_author_id, wp_category_ids, wp_tag_ids, wp_featured_media_id,
        wp_slug, wp_excerpt, wp_publish_at
      FROM content_tool.hitl2_snapshots
      WHERE run_id = ${runId}
      ORDER BY created_at DESC
      LIMIT ${HITL2_SNAPSHOT_KEEP}
    `,
  );
  return c.json(rows.map(toSnapshotOut));
});

// ---------------------------------------------------------------------------
// PUT /:id/outline — persist a post-hoc outline edit (outlines.human_edits)
// ---------------------------------------------------------------------------
runsRouter.put("/:id/outline", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");
  const body = await c.req.json<OutlineEditBody>().catch(() => ({}) as OutlineEditBody);

  const expectedVersion = body.expected_version ?? null;

  const outcome = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<{ version: number }[]>`
      SELECT version FROM content_tool.outlines WHERE run_id = ${runId} LIMIT 1
    `;
    const existing = rows[0];
    if (existing === undefined) {
      return { kind: "not_found" as const };
    }
    // Conditional UPDATE: only add the `AND version = $expected` guard when the
    // caller supplied an expected_version. Either way bump version by one.
    const result =
      expectedVersion === null
        ? await sql`
            UPDATE content_tool.outlines
            SET edited_by_human = TRUE,
                human_edits = ${toJsonb(sql, body.outline ?? null)},
                version = version + 1
            WHERE run_id = ${runId}
          `
        : await sql`
            UPDATE content_tool.outlines
            SET edited_by_human = TRUE,
                human_edits = ${toJsonb(sql, body.outline ?? null)},
                version = version + 1
            WHERE run_id = ${runId} AND version = ${expectedVersion}
          `;
    if (result.count === 0) {
      // Conditional WHERE matched no row → another reviewer saved since the
      // client loaded this outline. `existing.version` is the committed current.
      return { kind: "stale" as const, currentVersion: existing.version };
    }
    return { kind: "ok" as const };
  });

  if (outcome.kind === "not_found") {
    return c.json({ detail: "no outline for this run" }, 404);
  }
  if (outcome.kind === "stale") {
    return c.json(
      {
        error: "stale_version",
        message: "outline was changed since you loaded it",
        current_version: outcome.currentVersion,
      },
      409,
    );
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// PUT /:id/article — persist body/SEO onto the latest render + WP meta on the run
// ---------------------------------------------------------------------------
runsRouter.put("/:id/article", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");
  const body = await c.req
    .json<ArticleEditBody>()
    .catch(() => ({}) as ArticleEditBody);

  const expectedVersion = body.expected_version ?? null;

  const outcome = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const renderRows = await sql<{ render_id: string; version: number }[]>`
      SELECT r.render_id, r.version
      FROM content_tool.renders r
      JOIN content_tool.drafts d ON d.draft_id = r.draft_id
      WHERE d.run_id = ${runId}
      ORDER BY d.iteration DESC
      LIMIT 1
    `;
    const render = renderRows[0];
    if (render === undefined) {
      // Distinguish "no draft" vs "no render" the way the Python route does:
      const draftRows = await sql<{ draft_id: string }[]>`
        SELECT draft_id FROM content_tool.drafts WHERE run_id = ${runId} LIMIT 1
      `;
      return draftRows[0] === undefined
        ? ({ kind: "no_draft" as const })
        : ({ kind: "no_render" as const });
    }

    // Conditional UPDATE: only add the `AND version = $expected` guard when the
    // caller supplied an expected_version. Either way bump version by one.
    const result =
      expectedVersion === null
        ? await sql`
            UPDATE content_tool.renders
            SET html_body = ${body.html_body ?? ""},
                seo_title = ${body.seo_title ?? ""},
                meta_description = ${body.meta_description ?? ""},
                version = version + 1
            WHERE render_id = ${render.render_id}
          `
        : await sql`
            UPDATE content_tool.renders
            SET html_body = ${body.html_body ?? ""},
                seo_title = ${body.seo_title ?? ""},
                meta_description = ${body.meta_description ?? ""},
                version = version + 1
            WHERE render_id = ${render.render_id} AND version = ${expectedVersion}
          `;
    if (result.count === 0) {
      // Conditional WHERE matched no row → another reviewer saved since the
      // client loaded this render. `render.version` is the committed current.
      return { kind: "stale" as const, currentVersion: render.version };
    }

    // Only overwrite WP metadata fields the caller actually supplied (non-null);
    // COALESCE preserves the existing value for omitted fields.
    await sql`
      UPDATE content_tool.runs
      SET
        wp_publish_status = COALESCE(${body.wp_publish_status ?? null}, wp_publish_status),
        wp_author_id = COALESCE(${body.wp_author_id ?? null}, wp_author_id),
        wp_category_ids = COALESCE(${body.wp_category_ids == null ? null : toJsonb(sql, body.wp_category_ids)}, wp_category_ids),
        wp_tag_ids = COALESCE(${body.wp_tag_ids == null ? null : toJsonb(sql, body.wp_tag_ids)}, wp_tag_ids),
        wp_featured_media_id = COALESCE(${body.wp_featured_media_id ?? null}, wp_featured_media_id),
        wp_slug = COALESCE(${body.wp_slug ?? null}, wp_slug),
        wp_excerpt = COALESCE(${body.wp_excerpt ?? null}, wp_excerpt),
        wp_publish_at = COALESCE(${body.wp_publish_at ?? null}, wp_publish_at)
      WHERE run_id = ${runId}
    `;
    return { kind: "ok" as const };
  });

  if (outcome.kind === "no_draft") {
    return c.json({ detail: "no draft for this run" }, 404);
  }
  if (outcome.kind === "no_render") {
    return c.json({ detail: "no render for this run" }, 404);
  }
  if (outcome.kind === "stale") {
    return c.json(
      {
        error: "stale_version",
        message: "article was changed since you loaded it",
        current_version: outcome.currentVersion,
      },
      409,
    );
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /:id/apply-edits — stateless AI edit of the supplied HTML.
//
// The agent revises `html_body` per the anchored comments and/or overall notes
// and returns the revised HTML for the editor to review. No draft / render is
// created and nothing is published — that happens through Save / Approve. Works
// on a paused HITL_2 run or a finished one alike, since it never touches state.
// ---------------------------------------------------------------------------
runsRouter.post("/:id/apply-edits", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");
  const body = await c.req
    .json<ApplyEditsBody>()
    .catch(() => ({}) as ApplyEditsBody);

  const comments: ApplyEditComment[] = (body.comments ?? []).map((cc) => ({
    anchor_text: cc.anchor_text ?? "",
    body: cc.body ?? "",
  }));
  if ((body.html_body ?? "").trim().length === 0) {
    return c.json({ detail: "html_body is required" }, 400);
  }
  const hasComment = comments.some((cc) => cc.body.trim().length > 0);
  const hasNotes = (body.notes ?? "").trim().length > 0;
  if (!hasComment && !hasNotes) {
    return c.json({ detail: "no comments or notes provided" }, 400);
  }

  const gemini = new DoGeminiClient(c.env.GEMINI_PROXY, {
    model: c.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    thinkingLevel: DEFAULT_THINKING_LEVEL,
  });

  try {
    const htmlBody = await withDb(c.env, c.executionCtx, (sql: Sql) =>
      runApplyEdits(sql, gemini, {
        runId,
        htmlBody: body.html_body ?? "",
        comments,
        notes: body.notes ?? null,
      }),
    );
    return c.json({ html_body: htmlBody });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("run not found")) {
      return c.json({ detail: "run not found" }, 404);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// POST /:id/republish — re-push the persisted render + WP metadata to WordPress
// ---------------------------------------------------------------------------
runsRouter.post("/:id/republish", requireRole("editor"), async (c) => {
  const runId = c.req.param("id");

  const data = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const runRows = await sql<RepublishRunRow[]>`
      SELECT
        start_mode, created_by, wp_pushed_post_id, wp_publish_status, wp_author_id,
        wp_category_ids, wp_tag_ids, wp_featured_media_id, wp_slug, wp_excerpt
      FROM content_tool.runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    const run = runRows[0];
    if (run === undefined) {
      return { error: "not_found" as const };
    }
    const renderRows = await sql<RepublishRenderRow[]>`
      SELECT r.seo_title, r.meta_description, r.html_body, r.excerpt_suggestion, r.schema_jsonld
      FROM content_tool.renders r
      JOIN content_tool.drafts d ON d.draft_id = r.draft_id
      WHERE d.run_id = ${runId}
      ORDER BY d.iteration DESC
      LIMIT 1
    `;
    const render = renderRows[0];
    if (render === undefined) {
      return { error: "no_render" as const };
    }

    let fetchedPostId: number | null = null;
    if (run.start_mode === "refresh" && run.wp_pushed_post_id === null) {
      const faRows = await sql<{ wp_post_id: number | null }[]>`
        SELECT wp_post_id FROM content_tool.fetched_articles WHERE run_id = ${runId} LIMIT 1
      `;
      fetchedPostId = faRows[0]?.wp_post_id ?? null;
    }
    return { run, render, fetchedPostId };
  });

  if ("error" in data) {
    if (data.error === "not_found") {
      return c.json({ detail: "run not found" }, 404);
    }
    return c.json({ detail: "run has no render to publish" }, 409);
  }

  const { run, render, fetchedPostId } = data;
  const isRefresh = run.start_mode === "refresh";

  let client: WordPressClient;
  try {
    client = new WordPressClient(c.env);
  } catch {
    return c.json({ detail: "WordPress client not configured" }, 503);
  }

  // SEO plugin detection is best-effort — a WP outage must not block the push.
  let seoPlugin: SeoPlugin | null = null;
  try {
    seoPlugin = await detectSeoPlugin(c.env);
  } catch {
    seoPlugin = null;
  }

  const schemaJsonld =
    render.schema_jsonld !== null && render.schema_jsonld !== undefined
      ? pgJson<object[]>(render.schema_jsonld)
      : null;

  const postId = isRefresh
    ? (run.wp_pushed_post_id ?? fetchedPostId)
    : run.wp_pushed_post_id;
  // Honor the operator's status choice for both modes (default draft); a
  // "publish" selection must never be silently demoted on a re-push.
  const status = resolvePublishStatus(run.wp_publish_status);

  const payload: PublishPayload = {
    postId,
    title: render.seo_title,
    content: render.html_body,
    excerpt: run.wp_excerpt || (render.excerpt_suggestion ?? ""),
    status,
    slug: run.wp_slug,
    categories: toNumberArray(run.wp_category_ids),
    tags: toNumberArray(run.wp_tag_ids),
    author: run.wp_author_id,
    featuredMedia: run.wp_featured_media_id,
    meta: buildMeta(render.meta_description, schemaJsonld, seoPlugin),
    ifUnmodifiedSince: null,
    dateGmt: null,
    template: WP_DEFAULT_PAGE_TEMPLATE,
  };

  let result: Awaited<ReturnType<WordPressClient["upsert"]>>;
  try {
    result = await client.upsert(payload);
  } catch (e: unknown) {
    if (e instanceof WordPressError) {
      return c.json({ detail: `WordPress upstream error: ${e.message}` }, 502);
    }
    throw e;
  }

  // Backfill the WP post id + flip to published (mirror the workflow publish).
  await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    if (isRefresh) {
      await sql`
        UPDATE content_tool.runs
        SET wp_pushed_post_id = ${result.id}, wp_pushed_at = now(), status = 'published'
        WHERE run_id = ${runId}
      `;
    } else {
      await sql`
        UPDATE content_tool.runs
        SET wp_pushed_post_id = ${result.id}, wp_pushed_at = now(),
            status = 'published', article_url = ${result.link}
        WHERE run_id = ${runId}
      `;
    }
  });

  return c.json({
    wp_post_id: result.id,
    link: result.link ?? null,
    status: result.status,
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — hard-delete a run and its derived rows
//
// Content artifacts cascade via ON DELETE CASCADE. The soft back-references
// (topic_candidates.promoted_run_id, refresh_evaluations.resulting_run_id) and
// compliance_log do NOT cascade, so they are cleared explicitly first.
// ---------------------------------------------------------------------------
runsRouter.delete("/:id", requireRole("admin"), async (c) => {
  const runId = c.req.param("id");
  const deleted = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<{ run_id: string }[]>`
      SELECT run_id FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
    `;
    if (rows[0] === undefined) {
      return false;
    }
    await sql`
      UPDATE content_tool.topic_candidates SET promoted_run_id = NULL
      WHERE promoted_run_id = ${runId}
    `;
    await sql`
      UPDATE content_tool.refresh_evaluations SET resulting_run_id = NULL
      WHERE resulting_run_id = ${runId}
    `;
    await sql`DELETE FROM content_tool.compliance_log WHERE run_id = ${runId}`;
    await sql`DELETE FROM content_tool.runs WHERE run_id = ${runId}`;
    return true;
  });

  if (!deleted) {
    return c.json({ detail: "run not found" }, 404);
  }
  return c.json({ ok: true });
});

export { runsRouter };
export default runsRouter;
