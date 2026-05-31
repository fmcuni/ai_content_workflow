/**
 * Refresh route — Workers-native port of `content_tool/api/routes/refresh.py`.
 *
 *   POST /refresh/scan              → kick the REFRESH_SCAN workflow (full tick)
 *   POST /refresh/scan/:articleId   → scan a single article synchronously
 *   GET  /refresh/evaluations/:id   → fetch one refresh evaluation
 *
 * The full-tick scan is asynchronous here (it kicks the durable workflow and
 * returns a tick id) rather than blocking the request like the Python route — a
 * single HTTP request cannot hold a Worker open for a 200-article tick. The
 * per-article scan stays synchronous so the caller still gets the evaluation
 * back, mirroring the Python response.
 *
 * The LEAD owns index.ts; the REFRESH_SCAN Workflow binding is narrowed locally.
 */

import { Hono } from "hono";
import type { Sql } from "postgres";

import type { Env } from "../index";
import { withDb } from "../db/client";
import { pgJson, pgTimestampToIso } from "../db/serialize";
import { DoGeminiClient } from "../gemini/do_client";
import type { GeminiClient } from "../gemini/types";
import {
  IN_FLIGHT_STATUSES,
  scanArticle,
  type ArticleRow,
} from "../refresh/scanner";

const DEFAULT_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_THINKING_LEVEL = "HIGH";

// ---------------------------------------------------------------------------
// Env extension — the LEAD adds REFRESH_SCAN to the shared Env in index.ts.
// We narrow locally so this module typechecks against the fixed contract.
// ---------------------------------------------------------------------------

interface RefreshEnv extends Env {
  REFRESH_SCAN: Workflow<{ triggerSource: string; articleIds?: string[]; force?: boolean }>;
}

// ---------------------------------------------------------------------------
// Output shape — mirrors RefreshEvaluationOut (content_tool/api/schemas.py)
// ---------------------------------------------------------------------------

interface RefreshEvaluationOut {
  evaluation_id: string;
  evaluated_at: string | null;
  age_days: number;
  staleness_score: number;
  recommended_action: string;
  deterministic_findings: unknown;
  llm_findings: unknown;
  llm_skipped_reason: string | null;
  outcome: string;
  resulting_run_id: string | null;
}

interface EvaluationRow {
  evaluation_id: string;
  evaluated_at: string;
  age_days: number;
  staleness_score: string;
  recommended_action: string;
  deterministic_findings: unknown;
  llm_findings: unknown;
  llm_skipped_reason: string | null;
  outcome: string;
  resulting_run_id: string | null;
}

function toEvaluationOut(row: EvaluationRow): RefreshEvaluationOut {
  return {
    evaluation_id: row.evaluation_id,
    evaluated_at: pgTimestampToIso(row.evaluated_at),
    age_days: row.age_days,
    staleness_score: Number(row.staleness_score),
    recommended_action: row.recommended_action,
    deterministic_findings: pgJson(row.deterministic_findings),
    llm_findings: pgJson(row.llm_findings),
    llm_skipped_reason: row.llm_skipped_reason,
    outcome: row.outcome,
    resulting_run_id: row.resulting_run_id,
  };
}

const EVALUATION_COLUMNS = `
  evaluation_id, evaluated_at, age_days, staleness_score, recommended_action,
  deterministic_findings, llm_findings, llm_skipped_reason, outcome, resulting_run_id
`;

function geminiClient(env: Env): GeminiClient {
  return new DoGeminiClient(env.GEMINI_PROXY, {
    model: env.GEMINI_MODEL ?? DEFAULT_MODEL,
    thinkingLevel: DEFAULT_THINKING_LEVEL,
  });
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

interface ScanBody {
  article_ids?: string[];
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const refreshRouter = new Hono<{ Bindings: Env }>();

// POST /scan — kick a full scan tick via the REFRESH_SCAN workflow.
refreshRouter.post("/scan", async (c) => {
  const body = await c.req.json<ScanBody>().catch(() => ({}) as ScanBody);
  const env = c.env as RefreshEnv;
  const tickId = crypto.randomUUID();

  await env.REFRESH_SCAN.create({
    id: tickId,
    params: {
      triggerSource: "manual_api",
      articleIds: body.article_ids,
      force: body.force ?? false,
    },
  });

  return c.json({ tick_id: tickId, status: "started" });
});

// POST /scan/:articleId — scan a single article synchronously.
refreshRouter.post("/scan/:articleId", async (c) => {
  const articleId = c.req.param("articleId");
  const force = c.req.query("force") === "true";

  const guard = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<
      Array<ArticleRow & { dismissed_until: string | null }>
    >`
      SELECT article_id, article_url, wp_post_id, persona, first_seen_at,
             last_persisted_at, dismissed_until
      FROM content_tool.articles
      WHERE article_id = ${articleId}::uuid
      LIMIT 1
    `;
    const article = rows[0];
    if (article === undefined) {
      return { error: "not_found" as const };
    }
    if (article.dismissed_until !== null && !force) {
      return { error: "dismissed" as const };
    }
    const inflight = await sql<Array<{ run_id: string }>>`
      SELECT run_id FROM content_tool.runs
      WHERE article_id = ${articleId}::uuid
        AND status IN ${sql(IN_FLIGHT_STATUSES as unknown as string[])}
      LIMIT 1
    `;
    if (inflight[0] !== undefined) {
      return { error: "in_progress_run" as const, runId: inflight[0].run_id };
    }
    return { article };
  });

  if ("error" in guard) {
    if (guard.error === "not_found") {
      return c.json({ detail: "article not found" }, 404);
    }
    if (guard.error === "dismissed") {
      return c.json({ detail: { reason: "dismissed" } }, 410);
    }
    return c.json({ detail: { reason: "in_progress_run", run_id: guard.runId } }, 409);
  }

  const article: ArticleRow = {
    article_id: guard.article.article_id,
    article_url: guard.article.article_url,
    wp_post_id: guard.article.wp_post_id,
    persona: guard.article.persona,
    first_seen_at: guard.article.first_seen_at,
    last_persisted_at: guard.article.last_persisted_at,
  };

  const evaluation = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const scan = await scanArticle(sql, c.env, geminiClient(c.env), article, {
      triggerSource: "manual_per_article",
      llmBudgetRemaining: 999,
    });
    const rows = await sql<EvaluationRow[]>`
      SELECT ${sql.unsafe(EVALUATION_COLUMNS)}
      FROM content_tool.refresh_evaluations
      WHERE evaluation_id = ${scan.evaluationId}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  });

  if (evaluation === null) {
    return c.json({ detail: "evaluation not found" }, 500);
  }
  return c.json(toEvaluationOut(evaluation));
});

// GET /evaluations/:evaluationId — fetch one refresh evaluation.
refreshRouter.get("/evaluations/:evaluationId", async (c) => {
  const evaluationId = c.req.param("evaluationId");

  const row = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<EvaluationRow[]>`
      SELECT ${sql.unsafe(EVALUATION_COLUMNS)}
      FROM content_tool.refresh_evaluations
      WHERE evaluation_id = ${evaluationId}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  });

  if (row === null) {
    return c.json({ detail: "evaluation not found" }, 404);
  }
  return c.json(toEvaluationOut(row));
});

export { refreshRouter };
export default refreshRouter;
