import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import {
  listArticles,
  getArticleById,
  dismissArticle,
  clearDismissal,
} from "../db/articles";
import type { ArticleSortKey } from "../db/articles";

const articlesRouter = new Hono<{ Bindings: Env }>();

// POST /articles/:id/dismiss request body — mirrors the Python DismissRequest.
interface DismissBody {
  until?: string;
  reason?: string | null;
  dismissed_by?: string;
}

// GET / — list articles
// Query params:
//   needs_refresh  bool|null  — true: only articles with latest eval recommended_action='refresh' AND outcome='open'
//   persona        string     — exact match
//   topic_category string     — exact match
//   q              string     — topic ILIKE %q% OR article_url ILIKE %q%
//   sort           staleness|next_scan_due|last_persisted  (default: staleness)
//   limit          1–200      (default: 25)
//   offset         ≥0         (default: 0)
articlesRouter.get("/", async (c) => {
  const raw = c.req.query();

  // needs_refresh: "true" → true, "false" / absent → null (Python treats falsy as no-filter)
  const needs_refresh =
    raw.needs_refresh === "true"
      ? true
      : raw.needs_refresh === "false"
        ? false
        : null;

  const persona = raw.persona ?? null;
  const topic_category = raw.topic_category ?? null;
  const q = raw.q ?? null;

  const VALID_SORTS: ArticleSortKey[] = ["staleness", "next_scan_due", "last_persisted"];
  const sort: ArticleSortKey = VALID_SORTS.includes(raw.sort as ArticleSortKey)
    ? (raw.sort as ArticleSortKey)
    : "staleness";

  const limitRaw = parseInt(raw.limit ?? "25", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 25;

  const offsetRaw = parseInt(raw.offset ?? "0", 10);
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  const result = await withDb(c.env, c.executionCtx, (sql) =>
    listArticles(sql, { needs_refresh, persona, topic_category, q, sort, limit, offset }),
  );

  return c.json(result);
});

// GET /:articleId — article detail with recent_evaluations + recent_run_ids
articlesRouter.get("/:articleId", async (c) => {
  const articleId = c.req.param("articleId");

  const detail = await withDb(c.env, c.executionCtx, (sql) =>
    getArticleById(sql, articleId),
  );

  if (detail === null) {
    return c.json({ detail: "article not found" }, 404);
  }

  return c.json(detail);
});

// POST /:articleId/dismiss — snooze an article until a future timestamp.
// 422 when `until` is missing/unparseable or not in the future, or when
// `dismissed_by` is absent (mirrors the Python DismissRequest + future check);
// 404 when the article does not exist.
articlesRouter.post("/:articleId/dismiss", async (c) => {
  const articleId = c.req.param("articleId");
  const body = await c.req.json<DismissBody>().catch(() => null);
  if (body === null) {
    return c.json({ detail: "invalid JSON body" }, 422);
  }

  const dismissedBy = typeof body.dismissed_by === "string" ? body.dismissed_by : "";
  if (dismissedBy.length === 0) {
    return c.json({ detail: "dismissed_by is required" }, 422);
  }

  const until = typeof body.until === "string" ? body.until : "";
  const untilMs = until ? Date.parse(until) : Number.NaN;
  if (Number.isNaN(untilMs)) {
    return c.json({ detail: "until must be a valid timestamp" }, 422);
  }
  if (untilMs <= Date.now()) {
    return c.json({ detail: "until must be in the future" }, 422);
  }

  const reason = body.reason ?? null;
  // Normalise to an ISO string so the DB stores a canonical timestamptz value.
  const untilIso = new Date(untilMs).toISOString();

  const article = await withDb(c.env, c.executionCtx, (sql) =>
    dismissArticle(sql, articleId, untilIso, dismissedBy, reason),
  );
  if (article === null) {
    return c.json({ detail: "article not found" }, 404);
  }
  return c.json(article);
});

// DELETE /:articleId/dismiss — clear an existing dismissal.
// 404 when the article does not exist.
articlesRouter.delete("/:articleId/dismiss", async (c) => {
  const articleId = c.req.param("articleId");
  const article = await withDb(c.env, c.executionCtx, (sql) =>
    clearDismissal(sql, articleId),
  );
  if (article === null) {
    return c.json({ detail: "article not found" }, 404);
  }
  return c.json(article);
});

export { articlesRouter };
export default articlesRouter;
