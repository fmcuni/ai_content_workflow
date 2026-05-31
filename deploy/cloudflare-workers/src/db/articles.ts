import type { Sql } from "postgres";
import type { ArticleRow, RefreshEvaluationRow } from "./schema";
import { pgTimestampToIso } from "./serialize";

// ---------------------------------------------------------------------------
// Output types (mirror Python's ArticleOut / RefreshEvaluationOut / ArticleDetailOut)
// ---------------------------------------------------------------------------

export interface RefreshEvaluationOut {
  evaluation_id: string;
  evaluated_at: string;
  age_days: number;
  staleness_score: number;
  recommended_action: string;
  deterministic_findings: unknown;
  llm_findings: unknown | null;
  llm_skipped_reason: string | null;
  outcome: string;
  resulting_run_id: string | null;
}

export interface ArticleOut {
  article_id: string;
  article_url: string;
  wp_post_id: number | null;
  topic: string | null;
  persona: string | null;
  topic_category: string | null;
  first_seen_at: string;
  last_persisted_at: string | null;
  next_scan_due_at: string;
  dismissed_until: string | null;
  latest_evaluation: RefreshEvaluationOut | null;
  open_runs_count: number;
}

export interface ArticleDetailOut extends ArticleOut {
  recent_evaluations: RefreshEvaluationOut[];
  recent_run_ids: string[];
}

export interface ArticleListResponse {
  items: ArticleOut[];
  total: number;
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export type ArticleSortKey = "staleness" | "next_scan_due" | "last_persisted";

export interface ListArticlesParams {
  needs_refresh: boolean | null;
  persona: string | null;
  topic_category: string | null;
  q: string | null;
  sort: ArticleSortKey;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Open-run status set — must match Python's _OPEN_STATUSES exactly
// ---------------------------------------------------------------------------

const OPEN_STATUSES = [
  "pending",
  "strategy",
  "hitl_1",
  "production",
  "hitl_2",
  "persisted",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEvaluationOut(row: RefreshEvaluationRow): RefreshEvaluationOut {
  return {
    evaluation_id: row.evaluation_id,
    // evaluated_at is NOT NULL; helper never returns null here.
    evaluated_at: pgTimestampToIso(row.evaluated_at)!,
    age_days: row.age_days,
    staleness_score: row.staleness_score,
    recommended_action: row.recommended_action,
    deterministic_findings: row.deterministic_findings,
    llm_findings: row.llm_findings ?? null,
    llm_skipped_reason: row.llm_skipped_reason,
    outcome: row.outcome,
    resulting_run_id: row.resulting_run_id,
  };
}

function toArticleOut(
  row: ArticleRow,
  eval_row: RefreshEvaluationRow | null,
  open_runs_count: number,
): ArticleOut {
  return {
    article_id: row.article_id,
    article_url: row.article_url,
    wp_post_id: row.wp_post_id,
    topic: row.topic,
    persona: row.persona,
    topic_category: row.topic_category,
    // first_seen_at / next_scan_due_at are NOT NULL; the nullable columns pass
    // through the helper which preserves null.
    first_seen_at: pgTimestampToIso(row.first_seen_at)!,
    last_persisted_at: pgTimestampToIso(row.last_persisted_at),
    next_scan_due_at: pgTimestampToIso(row.next_scan_due_at)!,
    dismissed_until: pgTimestampToIso(row.dismissed_until),
    latest_evaluation: eval_row ? toEvaluationOut(eval_row) : null,
    open_runs_count,
  };
}

async function countOpenRuns(sql: Sql, article_id: string): Promise<number> {
  // Use the postgres.js `IN ${sql([...])}` value-list helper rather than
  // `= ANY(${array})`: with `fetch_types: false` the driver can't resolve the
  // array element OID and mis-serializes the list into a malformed array
  // literal. The `sql(array)` form expands to a parameterised `(?, ?, ...)`.
  const rows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*) AS cnt
    FROM content_tool.runs
    WHERE article_id = ${article_id}
      AND status IN ${sql(OPEN_STATUSES as unknown as string[])}
  `;
  return parseInt(rows[0]?.cnt ?? "0", 10);
}

// ---------------------------------------------------------------------------
// Public query functions
// ---------------------------------------------------------------------------

/**
 * List articles with optional filters, sort, and pagination.
 * Returns both the page of items and the total filtered count.
 *
 * SQL mirrors the Python route:
 *   - latest evaluation per article via row_number() OVER (PARTITION BY article_id ORDER BY evaluated_at DESC)
 *   - needs_refresh=true  → recommended_action='refresh' AND outcome='open'
 *   - needs_refresh=false/null → no evaluation filter
 *   - q → topic ILIKE %q% OR article_url ILIKE %q%
 *   - sort=staleness      → staleness_score DESC NULLS LAST
 *   - sort=next_scan_due  → next_scan_due_at ASC
 *   - sort=last_persisted → last_persisted_at DESC NULLS LAST
 */
export async function listArticles(
  sql: Sql,
  params: ListArticlesParams,
): Promise<ArticleListResponse> {
  const { needs_refresh, persona, topic_category, q, sort, limit, offset } = params;

  // Build the WHERE clauses as fragments
  const needsRefreshClause =
    needs_refresh === true
      ? sql`AND re.recommended_action = 'refresh' AND re.outcome = 'open'`
      : sql``;

  const personaClause =
    persona !== null ? sql`AND a.persona = ${persona}` : sql``;

  const topicCategoryClause =
    topic_category !== null
      ? sql`AND a.topic_category = ${topic_category}`
      : sql``;

  const likePattern = q !== null ? `%${q}%` : null;
  const qClause =
    likePattern !== null
      ? sql`AND (a.topic ILIKE ${likePattern} OR a.article_url ILIKE ${likePattern})`
      : sql``;

  // Sort clause
  const orderClause =
    sort === "staleness"
      ? sql`ORDER BY re.staleness_score DESC NULLS LAST`
      : sort === "next_scan_due"
        ? sql`ORDER BY a.next_scan_due_at ASC`
        : sql`ORDER BY a.last_persisted_at DESC NULLS LAST`;

  // CTE: latest evaluation per article
  type ListRow = ArticleRow & {
    // evaluation columns prefixed with e_ to avoid collision
    e_evaluation_id: string | null;
    e_evaluated_at: string | null;
    e_age_days: number | null;
    e_staleness_score: number | null;
    e_recommended_action: string | null;
    e_deterministic_findings: unknown | null;
    e_llm_findings: unknown | null;
    e_llm_skipped_reason: string | null;
    e_outcome: string | null;
    e_resulting_run_id: string | null;
  };

  const rows = await sql<ListRow[]>`
    WITH latest_evals AS (
      SELECT
        article_id,
        evaluation_id,
        evaluated_at,
        age_days,
        staleness_score,
        recommended_action,
        deterministic_findings,
        llm_findings,
        llm_skipped_reason,
        outcome,
        resulting_run_id,
        ROW_NUMBER() OVER (
          PARTITION BY article_id
          ORDER BY evaluated_at DESC
        ) AS rn
      FROM content_tool.refresh_evaluations
    ),
    latest AS (
      SELECT * FROM latest_evals WHERE rn = 1
    )
    SELECT
      a.article_id,
      a.article_url,
      a.wp_post_id,
      a.topic,
      a.persona,
      a.topic_category,
      a.first_seen_at,
      a.last_persisted_at,
      a.next_scan_due_at,
      a.dismissed_until,
      a.dismissed_by,
      a.dismissed_reason,
      a.updated_at,
      re.evaluation_id       AS e_evaluation_id,
      re.evaluated_at        AS e_evaluated_at,
      re.age_days            AS e_age_days,
      re.staleness_score     AS e_staleness_score,
      re.recommended_action  AS e_recommended_action,
      re.deterministic_findings AS e_deterministic_findings,
      re.llm_findings        AS e_llm_findings,
      re.llm_skipped_reason  AS e_llm_skipped_reason,
      re.outcome             AS e_outcome,
      re.resulting_run_id    AS e_resulting_run_id
    FROM content_tool.articles a
    LEFT JOIN latest re ON re.article_id = a.article_id
    WHERE TRUE
      ${needsRefreshClause}
      ${personaClause}
      ${topicCategoryClause}
      ${qClause}
    ${orderClause}
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  // Count query (same filters, no limit/offset)
  const countRows = await sql<{ cnt: string }[]>`
    WITH latest_evals AS (
      SELECT
        article_id,
        evaluation_id,
        recommended_action,
        outcome,
        ROW_NUMBER() OVER (
          PARTITION BY article_id
          ORDER BY evaluated_at DESC
        ) AS rn
      FROM content_tool.refresh_evaluations
    ),
    latest AS (
      SELECT * FROM latest_evals WHERE rn = 1
    )
    SELECT COUNT(*) AS cnt
    FROM content_tool.articles a
    LEFT JOIN latest re ON re.article_id = a.article_id
    WHERE TRUE
      ${needsRefreshClause}
      ${personaClause}
      ${topicCategoryClause}
      ${qClause}
  `;

  const total = parseInt(countRows[0]?.cnt ?? "0", 10);

  // For each row, fetch open_runs_count individually (matches Python's per-row N+1 approach)
  const items: ArticleOut[] = await Promise.all(
    rows.map(async (row) => {
      const evalRow: RefreshEvaluationRow | null =
        row.e_evaluation_id !== null
          ? {
              evaluation_id: row.e_evaluation_id,
              article_id: row.article_id,
              evaluated_at: row.e_evaluated_at ?? "",
              scanner_version: "",
              trigger_source: "",
              age_days: row.e_age_days ?? 0,
              fetched_html_hash: null,
              deterministic_findings: row.e_deterministic_findings,
              llm_findings: row.e_llm_findings ?? null,
              llm_skipped_reason: row.e_llm_skipped_reason,
              staleness_score: row.e_staleness_score ?? 0,
              recommended_action: row.e_recommended_action ?? "",
              outcome: row.e_outcome ?? "",
              resulting_run_id: row.e_resulting_run_id,
              outcome_set_at: null,
              outcome_set_by: null,
              tokens_in: null,
              tokens_out: null,
              est_cost_usd_cents: null,
              latency_ms: null,
            }
          : null;

      const articleRow: ArticleRow = {
        article_id: row.article_id,
        article_url: row.article_url,
        wp_post_id: row.wp_post_id,
        topic: row.topic,
        persona: row.persona,
        topic_category: row.topic_category,
        first_seen_at: row.first_seen_at,
        last_persisted_at: row.last_persisted_at,
        next_scan_due_at: row.next_scan_due_at,
        dismissed_until: row.dismissed_until,
        dismissed_by: row.dismissed_by,
        dismissed_reason: row.dismissed_reason,
        updated_at: row.updated_at,
      };

      const open_runs_count = await countOpenRuns(sql, row.article_id);
      return toArticleOut(articleRow, evalRow, open_runs_count);
    }),
  );

  return { items, total };
}

/**
 * Fetch a single article by UUID, with up to 10 recent evaluations and
 * 10 recent run IDs (both ordered by DESC timestamp).
 * Returns null if the article does not exist.
 */
export async function getArticleById(
  sql: Sql,
  articleId: string,
): Promise<ArticleDetailOut | null> {
  const articleRows = await sql<ArticleRow[]>`
    SELECT
      article_id, article_url, wp_post_id, topic, persona, topic_category,
      first_seen_at, last_persisted_at, next_scan_due_at, dismissed_until,
      dismissed_by, dismissed_reason, updated_at
    FROM content_tool.articles
    WHERE article_id = ${articleId}
    LIMIT 1
  `;

  const article = articleRows[0];
  if (article === undefined) {
    return null;
  }

  const [evalRows, runIdRows, open_runs_count] = await Promise.all([
    sql<RefreshEvaluationRow[]>`
      SELECT
        evaluation_id, article_id, evaluated_at, scanner_version, trigger_source,
        age_days, fetched_html_hash, deterministic_findings, llm_findings,
        llm_skipped_reason, staleness_score, recommended_action, outcome,
        resulting_run_id, outcome_set_at, outcome_set_by,
        tokens_in, tokens_out, est_cost_usd_cents, latency_ms
      FROM content_tool.refresh_evaluations
      WHERE article_id = ${articleId}
      ORDER BY evaluated_at DESC
      LIMIT 10
    `,
    sql<{ run_id: string }[]>`
      SELECT run_id
      FROM content_tool.runs
      WHERE article_id = ${articleId}
      ORDER BY created_at DESC
      LIMIT 10
    `,
    countOpenRuns(sql, articleId),
  ]);

  const latest = evalRows[0] ?? null;
  const base = toArticleOut(article, latest, open_runs_count);

  return {
    ...base,
    recent_evaluations: evalRows.map(toEvaluationOut),
    recent_run_ids: runIdRows.map((r) => r.run_id),
  };
}
