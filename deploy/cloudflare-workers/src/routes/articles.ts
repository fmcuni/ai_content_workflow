import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { listArticles, getArticleById } from "../db/articles";
import type { ArticleSortKey } from "../db/articles";

const articlesRouter = new Hono<{ Bindings: Env }>();

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

export { articlesRouter };
export default articlesRouter;
