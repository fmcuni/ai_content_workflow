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
import type { GhostPublisher } from "../publishers/ghost";
import { slugFromUrl } from "../util/url_slug";
import type { Env } from "../index";

// ---------------------------------------------------------------------------
// Input / Result
// ---------------------------------------------------------------------------

export interface FetchArticleInput {
  runId: string;
  articleUrl: string;
  /**
   * Which CMS this run's voice publishes to. When "ghost" we resolve the
   * existing post via the Ghost Admin API (by slug) instead of WordPress.
   * Defaults to the WordPress path when unset/"wordpress".
   */
  cmsKind?: "wordpress" | "ghost";
  /** Test seam — inject a client to avoid real network calls. */
  wpClient?: WordPressClient;
  /** Test seam — inject a Ghost publisher (read-only fetchPostBySlug here). */
  ghostPublisher?: GhostPublisher;
  /**
   * Test seam — inject a live-HTML fetcher. Defaults to a direct browser-UA
   * HTTP GET, used only when the URL can't be resolved as a WP post.
   */
  fetchLiveHtml?: (url: string) => Promise<string>;
}

export interface FetchArticleResult {
  wpPostId: number | null;
  /** Ghost post UUID (a string), or null for WordPress / live-page sources. */
  cmsPostId: string | null;
  wpCategories: WpCategory[];
  rawHtml: string;
  markdown: string;
  /**
   * Where the source content came from:
   *   "wp"    — resolved an existing post on the configured WordPress
   *   "ghost" — resolved an existing post on the configured Ghost site
   *   "live"  — fetched the live page directly (not a configured CMS post)
   * `wpPostId === null && cmsPostId === null` ⇒ no existing CMS post to update.
   */
  source: "wp" | "live" | "ghost";
}

// Direct live-page fetch timeout (ms). Independent of the WP REST timeout.
const LIVE_FETCH_TIMEOUT_MS = 20_000;

// A browser User-Agent — Cloudflare-fronted sites (e.g. gobowtie.com/my) return
// an Error 1010 challenge to non-browser agents, so a default scripting UA gets
// blocked. This mirrors the Python fallback.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
  cms_post_id: string | null;
  wp_categories: unknown;
  raw_html: string | null;
  markdown: string;
}

async function findExisting(
  sql: Sql,
  runId: string,
): Promise<FetchArticleResult | null> {
  const rows = await sql<FetchedArticleRow[]>`
    SELECT wp_post_id, cms_post_id, wp_categories, raw_html, markdown
    FROM content_tool.fetched_articles
    WHERE run_id = ${runId}::uuid
  `;
  const row = rows[0];
  if (row === undefined) return null;

  // A stored Ghost post id (cms_post_id) ⇒ "ghost"; else the existing wp/live
  // rule (a WP id ⇒ "wp", otherwise the live-page fallback).
  const source: FetchArticleResult["source"] =
    row.cms_post_id !== null ? "ghost" : row.wp_post_id === null ? "live" : "wp";

  return {
    wpPostId: row.wp_post_id,
    cmsPostId: row.cms_post_id,
    wpCategories: pgJson<WpCategory[] | null>(row.wp_categories) ?? [],
    rawHtml: row.raw_html ?? "",
    markdown: row.markdown,
    source,
  };
}

// ---------------------------------------------------------------------------
// Live-page fallback
//
// Used when the article URL can't be resolved as a post on the configured
// WordPress — e.g. it lives on a different site (gobowtie.com/my) or was never
// published to this CMS. We fetch the live HTML directly so the rewrite still
// has source material and the run is NOT blocked. Network failures degrade to
// an empty string (gap_analysis reads the live URL via Gemini urlContext as a
// second source), never an exception.
// ---------------------------------------------------------------------------

async function directLiveFetch(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!resp.ok) return "";
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) return "";
    return await resp.text();
  } catch {
    // Transient / WAF block / timeout — degrade to no markdown, never throw.
    return "";
  } finally {
    clearTimeout(timer);
  }
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

  // Ghost-target refresh: resolve the existing post via the Ghost Admin API so
  // gap_analysis sees the real post HTML and publish can UPDATE it (rather than
  // scraping the live page and minting a duplicate).
  if (input.cmsKind === "ghost") {
    return await fetchGhostArticle(sql, input);
  }

  const wpClient = input.wpClient ?? new WordPressClient(env);

  // Resolve the existing WP post. A transient/transport error from the CMS is
  // treated the same as "not found" so a CMS hiccup never hard-blocks the run.
  let post: Awaited<ReturnType<WordPressClient["fetchPostByUrl"]>> = null;
  try {
    post = await wpClient.fetchPostByUrl(input.articleUrl);
  } catch {
    post = null;
  }

  if (post === null) {
    return await fetchExternalArticle(sql, input);
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
      (run_id, wp_post_id, cms_post_id, wp_categories, wp_author_id, wp_slug, wp_link, raw_html, markdown)
    VALUES (
      ${input.runId}::uuid,
      ${post.id},
      ${null},
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
    cmsPostId: null,
    wpCategories: cats,
    rawHtml,
    markdown,
    source: "wp",
  };
}

// ---------------------------------------------------------------------------
// Ghost path (refresh on a Ghost target)
//
// Resolve the existing post by slug via the Ghost Admin API and persist a
// fetched_articles row carrying the Ghost UUID in cms_post_id (wp_post_id is
// NULL — Ghost ids are not integers). When the URL has no slug, no Ghost
// publisher was injected, the post isn't found, or a transient error is thrown
// (mirroring the WP "transient == not found" rule), degrade to the live-page
// fallback (cms_post_id null) so the run is never blocked.
// ---------------------------------------------------------------------------

async function fetchGhostArticle(
  sql: Sql,
  input: FetchArticleInput,
): Promise<FetchArticleResult> {
  const slug = slugFromUrl(input.articleUrl);
  const publisher = input.ghostPublisher;
  if (slug === null || publisher === undefined) {
    return await fetchExternalArticle(sql, input);
  }

  let post: Awaited<ReturnType<GhostPublisher["fetchPostBySlug"]>> = null;
  try {
    post = await publisher.fetchPostBySlug(slug);
  } catch {
    post = null;
  }
  if (post === null) {
    return await fetchExternalArticle(sql, input);
  }

  const rawHtml = post.html;
  const markdown = rawHtml === "" ? "" : htmlToMarkdown(rawHtml);

  await sql`
    INSERT INTO content_tool.fetched_articles
      (run_id, wp_post_id, cms_post_id, wp_categories, wp_author_id, wp_slug, wp_link, raw_html, markdown)
    VALUES (
      ${input.runId}::uuid,
      ${null},
      ${post.id},
      ${toJsonb(sql, [])},
      ${null},
      ${post.slug},
      ${post.url},
      ${rawHtml},
      ${markdown}
    )
  `;

  return {
    wpPostId: null,
    cmsPostId: post.id,
    wpCategories: [],
    rawHtml,
    markdown,
    source: "ghost",
  };
}

// ---------------------------------------------------------------------------
// External-source path (no WP post)
//
// The URL doesn't resolve to a post on the configured WordPress. Fetch the live
// page directly and persist a fetched_articles row with wp_post_id = NULL (no
// existing CMS post to update — publish, if later approved, mints a new draft).
// This keeps the run moving to HITL_2 instead of erroring out.
// ---------------------------------------------------------------------------

async function fetchExternalArticle(
  sql: Sql,
  input: FetchArticleInput,
): Promise<FetchArticleResult> {
  const fetchLiveHtml = input.fetchLiveHtml ?? directLiveFetch;
  const rawHtml = await fetchLiveHtml(input.articleUrl);
  const markdown = rawHtml === "" ? "" : htmlToMarkdown(rawHtml);

  await sql`
    INSERT INTO content_tool.fetched_articles
      (run_id, wp_post_id, cms_post_id, wp_categories, wp_author_id, wp_slug, wp_link, raw_html, markdown)
    VALUES (
      ${input.runId}::uuid,
      ${null},
      ${null},
      ${toJsonb(sql, [])},
      ${null},
      ${null},
      ${input.articleUrl},
      ${rawHtml},
      ${markdown}
    )
  `;

  return {
    wpPostId: null,
    cmsPostId: null,
    wpCategories: [],
    rawHtml,
    markdown,
    source: "live",
  };
}
