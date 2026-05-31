import { Hono } from "hono";
import type { Sql } from "postgres";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { pgJson, pgTimestampToIso, toJsonb } from "../db/serialize";
import { buildMeta, detectSeoPlugin } from "../wordpress/client";
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
  wp_pushed_post_id: number | null;
  wp_pushed_at: string | null;
  wp_push_error: unknown;
  topic_candidate_id: string | null;
  error: unknown;
}

interface RunHitl2StateRow {
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

const runsRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST / — create a run
// ---------------------------------------------------------------------------
runsRouter.post("/", async (c) => {
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
  const createdBy = body.editor_email ?? "";
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
// POST /:id/resume — HITL_1 decision
// ---------------------------------------------------------------------------
runsRouter.post("/:id/resume", async (c) => {
  const runId = c.req.param("id");
  const body = await c.req.json<ResumeBody>().catch(() => ({}) as ResumeBody);
  const decision = body.decision ?? "approve";

  await withDb(c.env, c.executionCtx, async (sql: Sql) => {
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
    await sql`
      UPDATE content_tool.runs
      SET hitl_1_decision = ${decision}, hitl_1_notes = ${body.notes ?? null}
      WHERE run_id = ${runId}
    `;
  });

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
runsRouter.post("/:id/hitl-2", async (c) => {
  const runId = c.req.param("id");
  const body = await c.req.json<Hitl2Body>().catch(() => ({}) as Hitl2Body);
  const decision = body.decision ?? "approve";
  const comments = body.comments ?? [];

  const guard = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<RunHitl2StateRow[]>`
      SELECT hitl_2_iteration FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
    `;
    const current = rows[0];
    if (current === undefined) {
      return { error: "not_found" as const };
    }

    // Belt + braces against tab races — UI also disables this.
    if (decision === "request_changes" && current.hitl_2_iteration >= HITL_2_MAX_ITERATIONS) {
      return { error: "cap_reached" as const };
    }

    const newIteration =
      decision === "request_changes"
        ? current.hitl_2_iteration + 1
        : current.hitl_2_iteration;

    await sql`
      UPDATE content_tool.runs SET
        hitl_2_decision = ${decision},
        hitl_2_notes = ${body.notes ?? null},
        hitl_2_comments = ${toJsonb(sql, comments)},
        hitl_2_iteration = ${newIteration},
        approved_at = ${decision === "approve" ? sql`now()` : null},
        approved_by = ${decision === "approve" ? createdByPlaceholder() : null},
        wp_publish_status = ${body.wp_publish_status ?? null},
        wp_author_id = ${body.wp_author_id ?? null},
        wp_category_ids = ${body.wp_category_ids == null ? null : toJsonb(sql, body.wp_category_ids)},
        wp_tag_ids = ${body.wp_tag_ids == null ? null : toJsonb(sql, body.wp_tag_ids)},
        wp_featured_media_id = ${body.wp_featured_media_id ?? null},
        wp_slug = ${body.wp_slug ?? null},
        wp_excerpt = ${body.wp_excerpt ?? null},
        wp_publish_at = ${body.wp_publish_at ?? null}
      WHERE run_id = ${runId}
    `;
    return { ok: true as const };
  });

  if ("error" in guard) {
    if (guard.error === "not_found") {
      return c.json({ detail: "run not found" }, 404);
    }
    return c.json({ detail: "request_changes cap reached" }, 409);
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

/** Placeholder approver identity — Plan 4 binds the real editor identity. */
function createdByPlaceholder(): string {
  return "placeholder-editor";
}

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
runsRouter.post("/:id/dry-publish", async (c) => {
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
  const status = ov.wp_publish_status ?? run.wp_publish_status ?? "draft";
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
      { payload: unknown; edited_by_human: boolean; human_edits: unknown }[]
    >`
      SELECT payload, edited_by_human, human_edits
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
      }[]
    >`
      SELECT
        r.seo_title, r.meta_description, r.html_body, r.faq_schema_jsonld,
        r.schema_jsonld, r.excerpt_suggestion, r.slug_suggestion
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

export { runsRouter };
export default runsRouter;
