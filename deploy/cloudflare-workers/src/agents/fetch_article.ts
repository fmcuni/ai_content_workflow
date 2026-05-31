/**
 * Fetch-article agent — TypeScript port of `content_tool/agents/fetch_article.py`.
 *
 * Idempotent: if a `content_tool.fetched_articles` row already exists for the
 * run, it short-circuits and returns the stored values (lets the pipeline
 * recover from partial failures and supports out-of-band seeding when the live
 * URL is behind a WAF). Otherwise it resolves the existing WP post by URL,
 * hydrates full category objects, converts the HTML body to Markdown, and
 * inserts a single row.
 */

import type { Sql } from "postgres";
import { NodeHtmlMarkdown } from "node-html-markdown";

import { toJsonb, pgJson } from "../db/serialize";
import { WordPressClient } from "../wordpress/client";
import type { WpCategory } from "../wordpress/types";
import type { Env } from "../index";

// ---------------------------------------------------------------------------
// Input / Result
// ---------------------------------------------------------------------------

export interface FetchArticleInput {
  runId: string;
  articleUrl: string;
  /** Test seam — inject a client to avoid real network calls. */
  wpClient?: WordPressClient;
}

export interface FetchArticleResult {
  wpPostId: number | null;
  wpCategories: WpCategory[];
  rawHtml: string;
  markdown: string;
}

// ---------------------------------------------------------------------------
// HTML → Markdown
//
// Python uses `markdownify(html, heading_style="ATX")`. We use
// `node-html-markdown` (ATX headings by default) — a pure-JS converter backed by
// node-html-parser with NO DOM dependency, so it runs in the Workers runtime.
// (`turndown` was tried first but throws `document is not defined` at runtime —
// it requires a browser/jsdom DOM the Workers isolate does not provide.)
// Byte-for-byte parity with markdownify is NOT guaranteed (different list/
// emphasis/escaping rules) — but this markdown is LLM input context, not a
// parity-critical published artifact.
// ---------------------------------------------------------------------------

function htmlToMarkdown(html: string): string {
  return NodeHtmlMarkdown.translate(html);
}

// ---------------------------------------------------------------------------
// Existing-row lookup
// ---------------------------------------------------------------------------

interface FetchedArticleRow {
  wp_post_id: number | null;
  wp_categories: unknown;
  raw_html: string | null;
  markdown: string;
}

async function findExisting(
  sql: Sql,
  runId: string,
): Promise<FetchArticleResult | null> {
  const rows = await sql<FetchedArticleRow[]>`
    SELECT wp_post_id, wp_categories, raw_html, markdown
    FROM content_tool.fetched_articles
    WHERE run_id = ${runId}::uuid
  `;
  const row = rows[0];
  if (row === undefined) return null;

  return {
    wpPostId: row.wp_post_id,
    wpCategories: pgJson<WpCategory[] | null>(row.wp_categories) ?? [],
    rawHtml: row.raw_html ?? "",
    markdown: row.markdown,
  };
}

// ---------------------------------------------------------------------------
// Category hydration
//
// Python fetches full category objects ({id, name, slug}) from the WP
// categories endpoint to preserve the stored shape. The TS WordPressClient
// already exposes getCategory(id) returning exactly {id, name, slug}, so we
// hydrate each id and drop any that 404.
// ---------------------------------------------------------------------------

async function hydrateCategories(
  client: WordPressClient,
  categoryIds: number[],
): Promise<WpCategory[]> {
  const cats: WpCategory[] = [];
  for (const id of categoryIds) {
    const cat = await client.getCategory(id);
    if (cat !== null) cats.push(cat);
  }
  return cats;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the fetch-article agent for a single run.
 *
 * Mirrors Python `fetch_article`: idempotent short-circuit, resolve WP post by
 * URL, hydrate categories, convert HTML→Markdown, and INSERT a
 * `content_tool.fetched_articles` row (run_id is the PK — supplied by caller).
 */
export async function runFetchArticle(
  sql: Sql,
  env: Env,
  input: FetchArticleInput,
): Promise<FetchArticleResult> {
  // Short-circuit if this run already has a fetched-article row.
  const existing = await findExisting(sql, input.runId);
  if (existing !== null) return existing;

  const wpClient = input.wpClient ?? new WordPressClient(env);

  const post = await wpClient.fetchPostByUrl(input.articleUrl);
  if (post === null) {
    throw new Error(`WP post not found for ${input.articleUrl}`);
  }

  const cats = await hydrateCategories(wpClient, post.categories);
  const rawHtml = post.contentHtml;
  const markdown = htmlToMarkdown(rawHtml);

  // INSERT into content_tool.fetched_articles. run_id is the table's PK (NOT
  // NULL, no DB default) — supplied here, exactly as the Python backend does.
  // wp_categories is jsonb → written via toJsonb (native jsonb param), never a
  // pre-serialized `::jsonb` string.
  await sql`
    INSERT INTO content_tool.fetched_articles
      (run_id, wp_post_id, wp_categories, wp_author_id, wp_slug, wp_link, raw_html, markdown)
    VALUES (
      ${input.runId}::uuid,
      ${post.id},
      ${toJsonb(sql, cats)},
      ${post.author},
      ${post.slug},
      ${post.link},
      ${rawHtml},
      ${markdown}
    )
  `;

  return {
    wpPostId: post.id,
    wpCategories: cats,
    rawHtml,
    markdown,
  };
}
