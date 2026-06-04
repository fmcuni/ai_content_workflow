import { Hono } from "hono";
import type { Sql } from "postgres";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { getEventLogs, parseLogQuery } from "../db/event-log";
import { pgJson, pgTimestampToIso, toJsonb } from "../db/serialize";
import { corsPreflight, resolveCorsOrigin, withCors } from "../http/cors";

// ---------------------------------------------------------------------------
// Env extension
//
// The shared `Env` interface (src/index.ts) declares PRODUCTION + RUN_STREAM
// but not the TOPIC_EXPANSION Workflow binding. The lead owns index.ts; this
// file must not edit it. We narrow locally so this module typechecks against
// the fixed contract — same approach as `RunsEnv` in runs.ts.
// ---------------------------------------------------------------------------

// TODO: integration agent adds TOPIC_EXPANSION to Env
interface TopicEnv extends Env {
  TOPIC_EXPANSION: Workflow<{ batchId: string }>;
  PRODUCTION: Workflow<{ runId: string }>;
}

// ---------------------------------------------------------------------------
// Constants — mirror content_tool/api/routes/topic_batches.py
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["done", "failed"]);
const RESOLVED_CANDIDATE_STATUSES: ReadonlySet<string> = new Set([
  "promoted",
  "skipped",
]);

const PROMOTE_MODES = ["create", "refresh"] as const;
type PromoteMode = (typeof PROMOTE_MODES)[number];

const DEFAULT_PERSONA = "bowtie-editor";

// ---------------------------------------------------------------------------
// Request body types (mirror content_tool/api/schemas.py)
// ---------------------------------------------------------------------------

interface TopicBatchIn {
  research_theme?: string;
  target_audience?: string;
  topic_count?: number;
  keywords_per_topic?: number;
  must_cover?: string[];
  must_avoid?: string[];
  priority_focus?: string | null;
  notes?: string | null;
  persona_default?: string | null;
  acf_adv_id_default?: number | null;
  acf_widget_id_default?: number | null;
  auto_accept_hitl1_default?: boolean;
  editor_email?: string;
}

interface PatchCandidateIn {
  topic?: string;
  keywords?: string[];
  persona_slug?: string | null;
  acf_adv_id?: number | null;
  acf_widget_id?: number | null;
  operator_note?: string | null;
  editor_email?: string;
}

interface SkipCandidateRequest {
  editor_email?: string;
}

interface PromotionItem {
  candidate_id?: string;
  mode?: string;
}

interface PromoteRequest {
  promotions?: PromotionItem[];
  editor_email?: string;
}

// ---------------------------------------------------------------------------
// Output types (mirror the Python TopicBatchOut / TopicCandidateOut dicts)
// ---------------------------------------------------------------------------

interface TopicCandidateOut {
  candidate_id: string;
  batch_id: string;
  position: number;
  status: string;
  topic: string;
  keywords: unknown;
  original_topic: string;
  original_keywords: unknown;
  existing: string | null;
  existing_note: string | null;
  existing_url: string | null;
  hot_topic: string | null;
  hot_topic_note: string | null;
  existing_search_debug: unknown;
  persona_slug: string | null;
  acf_adv_id: number | null;
  acf_widget_id: number | null;
  operator_note: string | null;
  promote_mode: string | null;
  promoted_run_id: string | null;
  last_error: string | null;
  last_edited_by: string | null;
  last_edited_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface TopicBatchOut {
  batch_id: string;
  status: string;
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
  research_theme: string;
  target_audience: string;
  topic_count: number;
  keywords_per_topic: number;
  must_cover: unknown;
  must_avoid: unknown;
  priority_focus: string | null;
  notes: string | null;
  persona_default: string | null;
  acf_adv_id_default: number | null;
  acf_widget_id_default: number | null;
  auto_accept_hitl1_default: boolean;
  cost_cents: number;
  last_error: string | null;
  candidates?: TopicCandidateOut[];
}

// ---------------------------------------------------------------------------
// Row types (the columns each query selects)
// ---------------------------------------------------------------------------

interface BatchRow {
  batch_id: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  research_theme: string;
  target_audience: string;
  topic_count: number;
  keywords_per_topic: number;
  must_cover: unknown;
  must_avoid: unknown;
  priority_focus: string | null;
  notes: string | null;
  persona_default: string | null;
  acf_adv_id_default: number | null;
  acf_widget_id_default: number | null;
  auto_accept_hitl1_default: boolean;
  cost_cents: number;
  last_error: string | null;
}

interface CandidateRow {
  candidate_id: string;
  batch_id: string;
  position: number;
  status: string;
  topic: string;
  keywords: unknown;
  original_topic: string;
  original_keywords: unknown;
  existing: string | null;
  existing_note: string | null;
  existing_url: string | null;
  hot_topic: string | null;
  hot_topic_note: string | null;
  existing_search_debug: unknown;
  persona_slug: string | null;
  acf_adv_id: number | null;
  acf_widget_id: number | null;
  operator_note: string | null;
  promote_mode: string | null;
  promoted_run_id: string | null;
  last_error: string | null;
  last_edited_by: string | null;
  last_edited_at: string | null;
  created_at: string;
  updated_at: string;
}

const BATCH_COLUMNS = `
  batch_id, status, created_by, created_at, updated_at, research_theme,
  target_audience, topic_count, keywords_per_topic, must_cover, must_avoid,
  priority_focus, notes, persona_default, acf_adv_id_default,
  acf_widget_id_default, auto_accept_hitl1_default, cost_cents, last_error
`;

const CANDIDATE_COLUMNS = `
  candidate_id, batch_id, position, status, topic, keywords, original_topic,
  original_keywords, existing, existing_note, existing_url, hot_topic,
  hot_topic_note, existing_search_debug, persona_slug, acf_adv_id, acf_widget_id,
  operator_note, promote_mode, promoted_run_id, last_error, last_edited_by,
  last_edited_at, created_at, updated_at
`;

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toBatchOut(row: BatchRow): TopicBatchOut {
  return {
    batch_id: row.batch_id,
    status: row.status,
    created_by: row.created_by,
    created_at: pgTimestampToIso(row.created_at),
    updated_at: pgTimestampToIso(row.updated_at),
    research_theme: row.research_theme,
    target_audience: row.target_audience,
    topic_count: row.topic_count,
    keywords_per_topic: row.keywords_per_topic,
    must_cover: pgJson(row.must_cover) ?? [],
    must_avoid: pgJson(row.must_avoid) ?? [],
    priority_focus: row.priority_focus,
    notes: row.notes,
    persona_default: row.persona_default,
    acf_adv_id_default: row.acf_adv_id_default,
    acf_widget_id_default: row.acf_widget_id_default,
    auto_accept_hitl1_default: row.auto_accept_hitl1_default === true,
    cost_cents: row.cost_cents,
    last_error: row.last_error,
  };
}

function toCandidateOut(row: CandidateRow): TopicCandidateOut {
  return {
    candidate_id: row.candidate_id,
    batch_id: row.batch_id,
    position: row.position,
    status: row.status,
    topic: row.topic,
    keywords: pgJson(row.keywords) ?? [],
    original_topic: row.original_topic,
    original_keywords: pgJson(row.original_keywords) ?? [],
    existing: row.existing,
    existing_note: row.existing_note,
    existing_url: row.existing_url,
    hot_topic: row.hot_topic,
    hot_topic_note: row.hot_topic_note,
    existing_search_debug: pgJson(row.existing_search_debug) ?? null,
    persona_slug: row.persona_slug,
    acf_adv_id: row.acf_adv_id,
    acf_widget_id: row.acf_widget_id,
    operator_note: row.operator_note,
    promote_mode: row.promote_mode,
    promoted_run_id: row.promoted_run_id,
    last_error: row.last_error,
    last_edited_by: row.last_edited_by,
    last_edited_at: pgTimestampToIso(row.last_edited_at),
    created_at: pgTimestampToIso(row.created_at),
    updated_at: pgTimestampToIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

function selectBatch(sql: Sql, batchId: string): Promise<BatchRow[]> {
  return sql<BatchRow[]>`
    SELECT ${sql.unsafe(BATCH_COLUMNS)}
    FROM content_tool.topic_batches
    WHERE batch_id = ${batchId}
    LIMIT 1
  `;
}

function selectCandidate(
  sql: Sql,
  batchId: string,
  candidateId: string,
): Promise<CandidateRow[]> {
  return sql<CandidateRow[]>`
    SELECT ${sql.unsafe(CANDIDATE_COLUMNS)}
    FROM content_tool.topic_candidates
    WHERE candidate_id = ${candidateId} AND batch_id = ${batchId}
    LIMIT 1
  `;
}

/**
 * `done` iff every candidate is `promoted`/`skipped` — else
 * `partially_promoted`. Mirrors `_recompute_batch_status` in the Python route.
 */
async function recomputeBatchStatus(sql: Sql, batchId: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM content_tool.topic_candidates WHERE batch_id = ${batchId}
  `;
  const statuses = new Set(rows.map((r) => r.status));
  const allResolved =
    statuses.size > 0 &&
    [...statuses].every((s) => RESOLVED_CANDIDATE_STATUSES.has(s));
  const newStatus = allResolved ? "done" : "partially_promoted";
  await sql`
    UPDATE content_tool.topic_batches SET status = ${newStatus}
    WHERE batch_id = ${batchId}
  `;
  return newStatus;
}

function isPromoteMode(value: string | undefined): value is PromoteMode {
  return value === "create" || value === "refresh";
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const topicBatchesRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST / — create a topic batch + kick the topic-expansion workflow
// ---------------------------------------------------------------------------
topicBatchesRouter.post("/", async (c) => {
  const body = await c.req
    .json<TopicBatchIn>()
    .catch(() => ({}) as TopicBatchIn);

  const researchTheme = (body.research_theme ?? "").trim();
  const targetAudience = (body.target_audience ?? "").trim();
  if (researchTheme === "") {
    return c.json({ detail: "research_theme must not be empty" }, 422);
  }
  if (targetAudience === "") {
    return c.json({ detail: "target_audience must not be empty" }, 422);
  }

  const topicCount = body.topic_count ?? 10;
  if (!Number.isInteger(topicCount) || topicCount < 1 || topicCount > 30) {
    return c.json({ detail: "topic_count must be in [1, 30]" }, 422);
  }
  const keywordsPerTopic = body.keywords_per_topic ?? 5;
  if (
    !Number.isInteger(keywordsPerTopic) ||
    keywordsPerTopic < 1 ||
    keywordsPerTopic > 10
  ) {
    return c.json({ detail: "keywords_per_topic must be in [1, 10]" }, 422);
  }

  // batch_id == workflow instance id so /events + future addressing line up.
  const batchId = crypto.randomUUID();
  const mustCover = body.must_cover ?? [];
  const mustAvoid = body.must_avoid ?? [];
  const editorEmail = body.editor_email ?? "";

  const created = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<{ batch_id: string }[]>`
      INSERT INTO content_tool.topic_batches (
        batch_id, created_by, status, research_theme, target_audience,
        topic_count, keywords_per_topic, must_cover, must_avoid,
        priority_focus, notes, persona_default, acf_adv_id_default,
        acf_widget_id_default, auto_accept_hitl1_default
      ) VALUES (
        ${batchId}, ${editorEmail}, 'pending', ${researchTheme},
        ${targetAudience}, ${topicCount}, ${keywordsPerTopic},
        ${toJsonb(sql, mustCover)}, ${toJsonb(sql, mustAvoid)},
        ${body.priority_focus ?? null}, ${body.notes ?? null},
        ${body.persona_default ?? null}, ${body.acf_adv_id_default ?? null},
        ${body.acf_widget_id_default ?? null}, ${body.auto_accept_hitl1_default === true}
      )
      RETURNING batch_id
    `;
    return rows[0] ?? null;
  });

  if (created === null) {
    return c.json({ detail: "failed to create topic batch" }, 500);
  }

  const env = c.env as TopicEnv;
  await env.TOPIC_EXPANSION.create({ id: batchId, params: { batchId } });

  return c.json({ batch_id: created.batch_id, status: "pending" });
});

// ---------------------------------------------------------------------------
// GET / — list batches
// ---------------------------------------------------------------------------
topicBatchesRouter.get("/", async (c) => {
  const statusFilter = c.req.query("status") ?? null;
  const limitRaw = parseInt(
    c.req.query("limit") ?? String(DEFAULT_LIST_LIMIT),
    10,
  );
  const offsetRaw = parseInt(c.req.query("offset") ?? "0", 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIST_LIMIT;
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;

  if (limit < 1 || limit > MAX_LIST_LIMIT) {
    return c.json({ detail: "limit must be in [1, 200]" }, 422);
  }
  if (offset < 0) {
    return c.json({ detail: "offset must be >= 0" }, 422);
  }

  const rows = await withDb(c.env, c.executionCtx, (sql: Sql) => {
    const statusClause =
      statusFilter !== null ? sql`WHERE status = ${statusFilter}` : sql``;
    return sql<BatchRow[]>`
      SELECT ${sql.unsafe(BATCH_COLUMNS)}
      FROM content_tool.topic_batches
      ${statusClause}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  });

  return c.json(rows.map(toBatchOut));
});

// ---------------------------------------------------------------------------
// GET /:id — batch detail + nested candidates
// ---------------------------------------------------------------------------
topicBatchesRouter.get("/:id", async (c) => {
  const batchId = c.req.param("id");

  const data = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const batchRows = await selectBatch(sql, batchId);
    const batch = batchRows[0];
    if (batch === undefined) {
      return null;
    }
    const candidates = await sql<CandidateRow[]>`
      SELECT ${sql.unsafe(CANDIDATE_COLUMNS)}
      FROM content_tool.topic_candidates
      WHERE batch_id = ${batchId}
      ORDER BY position ASC
    `;
    return { batch, candidates };
  });

  if (data === null) {
    return c.json({ detail: "topic batch not found" }, 404);
  }
  const out = toBatchOut(data.batch);
  out.candidates = data.candidates.map(toCandidateOut);
  return c.json(out);
});

// ---------------------------------------------------------------------------
// GET /:id/events — SSE proxy to the RUN_STREAM Durable Object (keyed by batch).
// Opened cross-origin by the browser (Next rewrites buffer SSE) → CORS headers.
// ---------------------------------------------------------------------------
topicBatchesRouter.get("/:id/events", async (c) => {
  const batchId = c.req.param("id");
  const stub = c.env.RUN_STREAM.get(c.env.RUN_STREAM.idFromName(batchId));
  const res = await stub.fetch("https://run-stream/events");
  const origin = resolveCorsOrigin(c.req.header("origin") ?? null, c.env.FRONTEND_ORIGIN);
  return withCors(res, origin);
});

topicBatchesRouter.options("/:id/events", (c) =>
  corsPreflight(resolveCorsOrigin(c.req.header("origin") ?? null, c.env.FRONTEND_ORIGIN)),
);

// ---------------------------------------------------------------------------
// GET /:id/logs — verbose persisted per-step event log for this topic batch.
// Same contract as /runs/:id/logs: ordered seq ASC, since_seq/limit/level.
// ---------------------------------------------------------------------------
topicBatchesRouter.get("/:id/logs", async (c) => {
  const batchId = c.req.param("id");
  const query = parseLogQuery(new URL(c.req.url).searchParams);
  const rows = await withDb(c.env, c.executionCtx, (sql: Sql) =>
    getEventLogs(sql, batchId, query),
  );
  const origin = resolveCorsOrigin(c.req.header("origin") ?? null, c.env.FRONTEND_ORIGIN);
  return c.json(rows, 200, { "access-control-allow-origin": origin, vary: "Origin" });
});

topicBatchesRouter.options("/:id/logs", (c) =>
  corsPreflight(resolveCorsOrigin(c.req.header("origin") ?? null, c.env.FRONTEND_ORIGIN)),
);

// ---------------------------------------------------------------------------
// PATCH /:id/candidates/:cid — partial update
// ---------------------------------------------------------------------------
topicBatchesRouter.patch("/:id/candidates/:cid", async (c) => {
  const batchId = c.req.param("id");
  const candidateId = c.req.param("cid");
  const body = await c.req
    .json<PatchCandidateIn>()
    .catch(() => ({}) as PatchCandidateIn);

  const result = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const batchRows = await selectBatch(sql, batchId);
    const batch = batchRows[0];
    if (batch === undefined) {
      return { error: "batch_not_found" as const };
    }
    if (TERMINAL_STATUSES.has(batch.status)) {
      return { error: "terminal" as const, status: batch.status };
    }
    const candRows = await selectCandidate(sql, batchId, candidateId);
    if (candRows[0] === undefined) {
      return { error: "candidate_not_found" as const };
    }

    // Build the SET list from only the explicitly-provided editable fields,
    // mirroring `model_dump(exclude_unset=True, exclude={"editor_email"})`.
    const assignments: ReturnType<Sql>[] = [];
    if (body.topic !== undefined) {
      assignments.push(sql`topic = ${body.topic}`);
    }
    if (body.keywords !== undefined) {
      assignments.push(sql`keywords = ${toJsonb(sql, body.keywords)}`);
    }
    if (body.persona_slug !== undefined) {
      assignments.push(sql`persona_slug = ${body.persona_slug}`);
    }
    if (body.acf_adv_id !== undefined) {
      assignments.push(sql`acf_adv_id = ${body.acf_adv_id}`);
    }
    if (body.acf_widget_id !== undefined) {
      assignments.push(sql`acf_widget_id = ${body.acf_widget_id}`);
    }
    if (body.operator_note !== undefined) {
      assignments.push(sql`operator_note = ${body.operator_note}`);
    }

    if (assignments.length > 0) {
      assignments.push(sql`last_edited_by = ${body.editor_email ?? ""}`);
      assignments.push(sql`last_edited_at = now()`);
      await sql`
        UPDATE content_tool.topic_candidates
        SET ${assignments.reduce((acc, a) => sql`${acc}, ${a}`)}
        WHERE candidate_id = ${candidateId} AND batch_id = ${batchId}
      `;
    }

    const refreshed = await selectCandidate(sql, batchId, candidateId);
    return { ok: true as const, candidate: refreshed[0] };
  });

  if ("error" in result) {
    if (result.error === "batch_not_found") {
      return c.json({ detail: "topic batch not found" }, 404);
    }
    if (result.error === "candidate_not_found") {
      return c.json({ detail: "candidate not found" }, 404);
    }
    return c.json(
      { detail: `batch is in terminal status '${result.status}'` },
      409,
    );
  }
  if (result.candidate === undefined) {
    return c.json({ detail: "candidate not found" }, 404);
  }
  return c.json(toCandidateOut(result.candidate));
});

// ---------------------------------------------------------------------------
// POST /:id/candidates/:cid/skip — mark skipped + recompute batch status
// ---------------------------------------------------------------------------
topicBatchesRouter.post("/:id/candidates/:cid/skip", async (c) => {
  const batchId = c.req.param("id");
  const candidateId = c.req.param("cid");
  const body = await c.req
    .json<SkipCandidateRequest>()
    .catch(() => ({}) as SkipCandidateRequest);

  const result = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const batchRows = await selectBatch(sql, batchId);
    const batch = batchRows[0];
    if (batch === undefined) {
      return { error: "batch_not_found" as const };
    }
    if (TERMINAL_STATUSES.has(batch.status)) {
      return { error: "terminal" as const, status: batch.status };
    }
    const candRows = await selectCandidate(sql, batchId, candidateId);
    const cand = candRows[0];
    if (cand === undefined) {
      return { error: "candidate_not_found" as const };
    }
    if (RESOLVED_CANDIDATE_STATUSES.has(cand.status)) {
      return { error: "resolved" as const, status: cand.status };
    }

    await sql`
      UPDATE content_tool.topic_candidates
      SET status = 'skipped', last_edited_by = ${body.editor_email ?? ""},
          last_edited_at = now()
      WHERE candidate_id = ${candidateId} AND batch_id = ${batchId}
    `;
    await recomputeBatchStatus(sql, batchId);
    const refreshed = await selectCandidate(sql, batchId, candidateId);
    return { ok: true as const, candidate: refreshed[0] };
  });

  if ("error" in result) {
    if (result.error === "batch_not_found") {
      return c.json({ detail: "topic batch not found" }, 404);
    }
    if (result.error === "candidate_not_found") {
      return c.json({ detail: "candidate not found" }, 404);
    }
    if (result.error === "resolved") {
      return c.json(
        { detail: `candidate already resolved (status=${result.status})` },
        409,
      );
    }
    return c.json(
      { detail: `batch is in terminal status '${result.status}'` },
      409,
    );
  }
  if (result.candidate === undefined) {
    return c.json({ detail: "candidate not found" }, 404);
  }
  return c.json(toCandidateOut(result.candidate));
});

// ---------------------------------------------------------------------------
// POST /:id/promote — fan-out to runs
// ---------------------------------------------------------------------------
interface PromoteResultItem {
  candidate_id: string;
  run_id: string;
  mode: PromoteMode;
}

interface ValidatedPromotion {
  candidate: CandidateRow;
  mode: PromoteMode;
  runId: string;
}

topicBatchesRouter.post("/:id/promote", async (c) => {
  const batchId = c.req.param("id");
  const body = await c.req
    .json<PromoteRequest>()
    .catch(() => ({}) as PromoteRequest);

  const promotions = body.promotions ?? [];
  if (promotions.length === 0) {
    return c.json({ detail: "promotions must not be empty" }, 422);
  }
  // Each promotion item must carry a candidate_id + a valid mode.
  for (const p of promotions) {
    if (p.candidate_id === undefined || p.candidate_id === "") {
      return c.json({ detail: "each promotion requires candidate_id" }, 422);
    }
    if (!isPromoteMode(p.mode)) {
      return c.json(
        { detail: "each promotion mode must be 'create' or 'refresh'" },
        422,
      );
    }
  }
  const editorEmail = body.editor_email ?? "";

  const result = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const batchRows = await selectBatch(sql, batchId);
    const batch = batchRows[0];
    if (batch === undefined) {
      return { error: "batch_not_found" as const };
    }
    if (batch.status === "failed") {
      return { error: "failed_batch" as const };
    }
    if (TERMINAL_STATUSES.has(batch.status)) {
      return { error: "terminal" as const, status: batch.status };
    }

    const candidateIds = promotions.map((p) => p.candidate_id as string);
    const rows = await sql<CandidateRow[]>`
      SELECT ${sql.unsafe(CANDIDATE_COLUMNS)}
      FROM content_tool.topic_candidates
      WHERE batch_id = ${batchId} AND candidate_id IN ${sql(candidateIds)}
    `;
    const byId = new Map<string, CandidateRow>(
      rows.map((r) => [r.candidate_id, r]),
    );

    // ---- Atomic validation (mirror Python ~453-506): reject everything
    // before a single run row is written. ----
    const missing = candidateIds.filter((cid) => !byId.has(cid));
    if (missing.length > 0) {
      return { error: "missing" as const, missing };
    }
    for (const p of promotions) {
      const cand = byId.get(p.candidate_id as string);
      if (cand === undefined) {
        return { error: "missing" as const, missing: [p.candidate_id as string] };
      }
      if (cand.existing === null || cand.hot_topic === null) {
        return { error: "not_analysed" as const, candidateId: cand.candidate_id };
      }
      if (RESOLVED_CANDIDATE_STATUSES.has(cand.status)) {
        return {
          error: "already_resolved" as const,
          candidateId: cand.candidate_id,
          status: cand.status,
        };
      }
      if (p.mode === "refresh" && (cand.existing_url ?? "").trim() === "") {
        return { error: "blank_url" as const, candidateId: cand.candidate_id };
      }
    }

    // ---- Insert one runs row per promotion (column list mirrors the runs.ts
    // POST / INSERT exactly). ----
    const validated: ValidatedPromotion[] = [];
    for (const p of promotions) {
      const cand = byId.get(p.candidate_id as string) as CandidateRow;
      const mode = p.mode as PromoteMode;
      const runId = crypto.randomUUID();
      const persona =
        cand.persona_slug || batch.persona_default || DEFAULT_PERSONA;
      // Null-aware: a candidate with no acf id inherits the batch default, but
      // an explicit 0 ("no element") is honoured rather than overridden.
      const advId = (cand.acf_adv_id ?? batch.acf_adv_id_default) ?? 0;
      const widgetId = (cand.acf_widget_id ?? batch.acf_widget_id_default) ?? 0;
      const keywords = pgJson<string[]>(cand.keywords) ?? [];
      const editNote = (cand.operator_note ?? "").trim() || null;
      const articleUrl = mode === "refresh" ? cand.existing_url : null;

      await sql`
        INSERT INTO content_tool.runs (
          run_id, created_by, status, article_url, topic, keywords, mode,
          edit_note, acf_adv_id, acf_widget_id, persona, topic_category,
          today_date, start_mode, topic_candidate_id, target_audience,
          triggered_by_evaluation_id, auto_accept_hitl1
        ) VALUES (
          ${runId}, ${editorEmail}, 'pending', ${articleUrl}, ${cand.topic},
          ${toJsonb(sql, keywords)}, 'auto', ${editNote}, ${advId}, ${widgetId},
          ${persona}, ${null}, CURRENT_DATE, ${mode},
          ${cand.candidate_id}, ${batch.target_audience}, ${null},
          ${batch.auto_accept_hitl1_default === true}
        )
      `;

      await sql`
        UPDATE content_tool.topic_candidates
        SET promoted_run_id = ${runId}, promote_mode = ${mode},
            status = 'promoted'
        WHERE candidate_id = ${cand.candidate_id} AND batch_id = ${batchId}
      `;
      validated.push({ candidate: cand, mode, runId });
    }

    const newStatus = await recomputeBatchStatus(sql, batchId);
    return { ok: true as const, validated, batchStatus: newStatus };
  });

  if ("error" in result) {
    switch (result.error) {
      case "batch_not_found":
        return c.json({ detail: "topic batch not found" }, 404);
      case "failed_batch":
        return c.json(
          { detail: "cannot promote candidates from a failed batch" },
          409,
        );
      case "terminal":
        return c.json(
          { detail: `batch is in terminal status '${result.status}'` },
          409,
        );
      case "missing":
        return c.json(
          { detail: `candidate(s) not in this batch: ${JSON.stringify(result.missing)}` },
          422,
        );
      case "not_analysed":
        return c.json(
          {
            detail: `candidate ${result.candidateId} is not yet analysed (existing/hot_topic still NULL)`,
          },
          422,
        );
      case "already_resolved":
        return c.json(
          {
            detail: `candidate ${result.candidateId} already resolved (status=${result.status})`,
          },
          422,
        );
      case "blank_url":
        return c.json(
          {
            detail: `candidate ${result.candidateId} cannot be promoted in refresh mode: existing_url is blank`,
          },
          422,
        );
    }
  }

  // AFTER all rows are committed, kick the PRODUCTION workflow per run — the
  // run-id IS the workflow instance id so resume routes can address it.
  const env = c.env as TopicEnv;
  for (const v of result.validated) {
    await env.PRODUCTION.create({ id: v.runId, params: { runId: v.runId } });
  }

  const items: PromoteResultItem[] = result.validated.map((v) => ({
    candidate_id: v.candidate.candidate_id,
    run_id: v.runId,
    mode: v.mode,
  }));
  return c.json({ items, batch_status: result.batchStatus });
});

// ---------------------------------------------------------------------------
// POST /:id/close — mark the batch done
// ---------------------------------------------------------------------------
topicBatchesRouter.post("/:id/close", async (c) => {
  const batchId = c.req.param("id");

  const result = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const batchRows = await selectBatch(sql, batchId);
    const batch = batchRows[0];
    if (batch === undefined) {
      return { error: "batch_not_found" as const };
    }
    if (TERMINAL_STATUSES.has(batch.status)) {
      return { error: "terminal" as const, status: batch.status };
    }
    await sql`
      UPDATE content_tool.topic_batches SET status = 'done'
      WHERE batch_id = ${batchId}
    `;
    const refreshed = await selectBatch(sql, batchId);
    return { ok: true as const, batch: refreshed[0] };
  });

  if ("error" in result) {
    if (result.error === "batch_not_found") {
      return c.json({ detail: "topic batch not found" }, 404);
    }
    return c.json(
      { detail: `batch already terminal (status=${result.status})` },
      409,
    );
  }
  if (result.batch === undefined) {
    return c.json({ detail: "topic batch not found" }, 404);
  }
  return c.json(toBatchOut(result.batch));
});

// ---------------------------------------------------------------------------
// DELETE /:id — hard-delete batch (+ cascade candidates)
//
// NOTE: the Python route also cancels any in-flight generation task before
// deleting (RunExecutor.cancel). The Workflows runtime here exposes no
// equivalent "cancel + delete checkpoint" handle to a route, so in-flight
// TOPIC_EXPANSION instances are left to terminate on their own — the lead
// owns workflow lifecycle. Runs promoted from this batch are kept; their
// soft back-reference runs.topic_candidate_id is nulled first so candidate
// rows can be removed without violating the FK.
// ---------------------------------------------------------------------------
topicBatchesRouter.delete("/:id", async (c) => {
  const batchId = c.req.param("id");

  const found = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const batchRows = await selectBatch(sql, batchId);
    if (batchRows[0] === undefined) {
      return false;
    }
    await sql`
      UPDATE content_tool.runs SET topic_candidate_id = NULL
      WHERE topic_candidate_id IN (
        SELECT candidate_id FROM content_tool.topic_candidates
        WHERE batch_id = ${batchId}
      )
    `;
    // Verbose event log has no FK to topic_batches (stream_id is run_id OR
    // batch_id), so clean it up explicitly before the batch row goes.
    await sql`DELETE FROM content_tool.run_event_logs WHERE stream_id = ${batchId}`;
    await sql`
      DELETE FROM content_tool.topic_batches WHERE batch_id = ${batchId}
    `;
    return true;
  });

  if (!found) {
    return c.json({ detail: "topic batch not found" }, 404);
  }
  return c.json({ ok: true });
});

export { topicBatchesRouter };
export default topicBatchesRouter;
