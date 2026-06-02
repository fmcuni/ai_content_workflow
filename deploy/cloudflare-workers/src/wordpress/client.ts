import type { Env } from "../index";
import type {
  FetchedPost,
  PublishPayload,
  PublishResult,
  SeoPlugin,
  WpCategory,
  WpUser,
} from "./types";

export type { FetchedPost, PublishPayload, PublishResult, SeoPlugin, WpCategory, WpUser };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_JSONLD_META_KEY = "_bowtie_schema_jsonld";
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class WordPressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WordPressError";
  }
}

export class WordPressConflictError extends WordPressError {
  constructor(message: string) {
    super(message);
    this.name = "WordPressConflictError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the Basic Auth header value from username + app password. */
function buildAuthHeader(username: string, appPassword: string): string {
  return `Basic ${btoa(`${username}:${appPassword}`)}`;
}

/**
 * Guard against CloudFront/WAF HTML challenges that come back as 2xx but with
 * a non-JSON body. Throws a descriptive WordPressError instead of letting
 * JSON.parse fail with a cryptic error.
 */
function assertJsonContentType(
  status: number,
  headers: Headers,
  bodyLength: number,
): void {
  const ctype = headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().startsWith("application/json") || bodyLength === 0) {
    const xCache = headers.get("x-cache") ?? null;
    throw new WordPressError(
      `WP REST returned non-JSON response (${status} ${ctype || "no content-type"}, ` +
        `${bodyLength} bytes, x-cache=${JSON.stringify(xCache)}) — likely a ` +
        `CloudFront/origin outage.`,
    );
  }
}

/**
 * Strip trailing Z or numeric timezone offset from an ISO datetime string so
 * WordPress receives a plain `YYYY-MM-DDTHH:mm:ss` for `date_gmt`.
 */
function stripTzSuffix(iso: string): string {
  return iso.replace(/Z$|[+-]\d{2}:\d{2}$/, "");
}

// ---------------------------------------------------------------------------
// SEO meta builder
// ---------------------------------------------------------------------------

/**
 * Build the `meta` object to send on every publish/update.
 *
 * - yoast   → `_yoast_wpseo_metadesc`
 * - rankmath → `rank_math_description`
 * - null    → no SEO description key
 *
 * When `schemaJsonld` is provided, always adds `_bowtie_schema_jsonld`
 * (JSON-encoded, non-ASCII preserved via JSON.stringify default behaviour).
 */
export function buildMeta(
  metaDescription: string | null,
  schemaJsonld: object[] | null,
  seoPlugin: SeoPlugin | null,
): Record<string, string> {
  const meta: Record<string, string> = {};

  if (metaDescription !== null) {
    if (seoPlugin === "yoast") {
      meta["_yoast_wpseo_metadesc"] = metaDescription;
    } else if (seoPlugin === "rankmath") {
      meta["rank_math_description"] = metaDescription;
    }
    // null → no SEO desc key added
  }

  if (schemaJsonld !== null) {
    // JSON.stringify preserves UTF-8 / non-ASCII by default — no ensure_ascii workaround needed.
    meta[SCHEMA_JSONLD_META_KEY] = JSON.stringify(schemaJsonld);
  }

  return meta;
}

// ---------------------------------------------------------------------------
// WordPress client
// ---------------------------------------------------------------------------

export class WordPressClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly appPassword: string;

  constructor(env: Env) {
    if (!env.WP_BASE_URL) throw new Error("WP_BASE_URL is required");
    if (!env.WP_USERNAME) throw new Error("WP_USERNAME is required");
    if (!env.WP_APP_PASSWORD) throw new Error("WP_APP_PASSWORD is required");

    this.baseUrl = env.WP_BASE_URL.replace(/\/$/, "");
    this.username = env.WP_USERNAME;
    this.appPassword = env.WP_APP_PASSWORD;
  }

  // -------------------------------------------------------------------------
  // upsert
  // -------------------------------------------------------------------------

  async upsert(p: PublishPayload): Promise<PublishResult> {
    const headers: Record<string, string> = {
      Authorization: buildAuthHeader(this.username, this.appPassword),
      "Content-Type": "application/json",
    };
    if (p.ifUnmodifiedSince) {
      headers["If-Unmodified-Since"] = p.ifUnmodifiedSince;
    }

    const body: Record<string, unknown> = {
      title: p.title,
      content: p.content,
      status: p.status,
      categories: p.categories,
      tags: p.tags,
      meta: p.meta,
      // Always send template: "" forces WP default; null is guarded below.
      template: p.template,
    };

    // Remove template key entirely when caller passes null (leave existing untouched).
    if (p.template === null) {
      delete body["template"];
    }

    if (p.excerpt !== null) body["excerpt"] = p.excerpt;
    if (p.slug !== null) body["slug"] = p.slug;
    if (p.author !== null) body["author"] = p.author;
    if (p.featuredMedia !== null) body["featured_media"] = p.featuredMedia;
    if (p.dateGmt !== null) body["date_gmt"] = stripTzSuffix(p.dateGmt);

    const url =
      p.postId !== null
        ? `${this.baseUrl}/wp-json/wp/v2/posts/${p.postId}`
        : `${this.baseUrl}/wp-json/wp/v2/posts`;
    const method = p.postId !== null ? "PUT" : "POST";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      throw new WordPressError(
        `transport_error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 412) {
      throw new WordPressConflictError(await resp.text());
    }
    if (!resp.ok) {
      const snippet = await resp.text();
      throw new WordPressError(`${resp.status}: ${snippet.slice(0, 500)}`);
    }

    // CloudFront/WAF guard: 2xx with non-JSON body
    const rawText = await resp.text();
    const ctype = resp.headers.get("content-type") ?? "";
    if (!ctype.toLowerCase().startsWith("application/json") || rawText.length === 0) {
      const xCache = resp.headers.get("x-cache") ?? null;
      throw new WordPressError(
        `WP REST returned non-JSON response (${resp.status} ${ctype || "no content-type"}, ` +
          `${rawText.length} bytes, x-cache=${JSON.stringify(xCache)}) — likely a ` +
          `CloudFront/origin outage.`,
      );
    }

    const data = JSON.parse(rawText) as Record<string, unknown>;
    return {
      id: data["id"] as number,
      link: data["link"] as string,
      status: data["status"] as string,
      modifiedGmt: data["modified_gmt"] as string,
      slug: data["slug"] as string,
    };
  }

  // -------------------------------------------------------------------------
  // fetchPostByUrl
  // -------------------------------------------------------------------------

  /**
   * Resolve a WordPress post by its public URL.
   * Strategy: extract the trailing slug from the URL path, then call
   * GET /wp/v2/posts?slug=<slug>&_fields=...
   */
  async fetchPostByUrl(articleUrl: string): Promise<FetchedPost | null> {
    const parsed = new URL(articleUrl);
    const slug = parsed.pathname.replace(/\/$/, "").split("/").pop() ?? "";
    if (!slug) return null;

    const params = new URLSearchParams({
      slug,
      _fields: "id,slug,link,title,content,modified_gmt,status,author,categories",
      status: "publish",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts?${params.toString()}`, {
        headers: { Authorization: buildAuthHeader(this.username, this.appPassword) },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      throw new WordPressError(
        `transport_error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const snippet = await resp.text();
      throw new WordPressError(`${resp.status}: ${snippet.slice(0, 500)}`);
    }

    const rawText = await resp.text();
    assertJsonContentType(resp.status, resp.headers, rawText.length);

    const posts = JSON.parse(rawText) as Array<Record<string, unknown>>;
    if (!Array.isArray(posts) || posts.length === 0) return null;

    const p: Record<string, unknown> = posts[0]!;
    const title = p["title"] as Record<string, unknown>;
    const contentField = p["content"] as Record<string, unknown>;

    return {
      id: p["id"] as number,
      slug: p["slug"] as string,
      link: p["link"] as string,
      title: title["rendered"] as string,
      contentHtml: contentField["rendered"] as string,
      modifiedGmt: p["modified_gmt"] as string,
      status: p["status"] as string,
      author: (p["author"] as number | null | undefined) ?? null,
      categories: (p["categories"] as number[] | undefined) ?? [],
    };
  }

  // -------------------------------------------------------------------------
  // listCategories / listUsers
  // -------------------------------------------------------------------------

  async listCategories(): Promise<WpCategory[]> {
    const rows = await this.listPaginated("/wp-json/wp/v2/categories", {
      hide_empty: "false",
    });
    return rows.map((r) => ({
      id: r["id"] as number,
      name: r["name"] as string,
      slug: r["slug"] as string,
    }));
  }

  async listUsers(): Promise<WpUser[]> {
    const rows = await this.listPaginated("/wp-json/wp/v2/users");
    return rows.map((r) => ({
      id: r["id"] as number,
      name: r["name"] as string,
      slug: r["slug"] as string,
    }));
  }

  // -------------------------------------------------------------------------
  // getUser / getCategory
  // -------------------------------------------------------------------------

  async getUser(userId: number): Promise<WpUser | null> {
    const row = await this.getSingle(`/wp-json/wp/v2/users/${userId}`);
    if (row === null) return null;
    return {
      id: row["id"] as number,
      name: row["name"] as string,
      slug: row["slug"] as string,
    };
  }

  async getCategory(categoryId: number): Promise<WpCategory | null> {
    const row = await this.getSingle(`/wp-json/wp/v2/categories/${categoryId}`);
    if (row === null) return null;
    return {
      id: row["id"] as number,
      name: row["name"] as string,
      slug: row["slug"] as string,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async listPaginated(
    path: string,
    extraParams?: Record<string, string>,
  ): Promise<Array<Record<string, unknown>>> {
    const authHeader = buildAuthHeader(this.username, this.appPassword);
    const baseParams: Record<string, string> = {
      per_page: "100",
      _fields: "id,name,slug",
      ...extraParams,
    };

    let page = 1;
    let totalPages = 1;
    const results: Array<Record<string, unknown>> = [];

    while (true) {
      const params = new URLSearchParams({ ...baseParams, page: String(page) });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
          headers: { Authorization: authHeader },
          signal: controller.signal,
        });
      } catch (err: unknown) {
        throw new WordPressError(
          `transport_error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }

      // CloudFront/WAF guard — before the error check so 2xx+HTML is diagnosed clearly.
      const rawText = await resp.text();
      assertJsonContentType(resp.status, resp.headers, rawText.length);

      if (!resp.ok) {
        throw new WordPressError(`${resp.status}: ${rawText.slice(0, 500)}`);
      }

      if (page === 1) {
        const totalPagesHeader = resp.headers.get("x-wp-totalpages");
        totalPages = totalPagesHeader ? (parseInt(totalPagesHeader, 10) || 1) : 1;
      }

      const items = JSON.parse(rawText) as Array<Record<string, unknown>>;
      results.push(...items);

      if (page >= totalPages) break;
      page += 1;
    }

    return results;
  }

  private async getSingle(path: string): Promise<Record<string, unknown> | null> {
    const params = new URLSearchParams({ _fields: "id,name,slug" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
        headers: { Authorization: buildAuthHeader(this.username, this.appPassword) },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      throw new WordPressError(
        `transport_error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 404) return null;

    const rawText = await resp.text();
    assertJsonContentType(resp.status, resp.headers, rawText.length);

    if (!resp.ok) {
      throw new WordPressError(`${resp.status}: ${rawText.slice(0, 500)}`);
    }

    return JSON.parse(rawText) as Record<string, unknown>;
  }
}

// ---------------------------------------------------------------------------
// Standalone SEO plugin detection (mirrors seo_plugin.py)
// ---------------------------------------------------------------------------

/**
 * Detect the installed SEO plugin by probing the WP REST schema.
 *
 * Sends OPTIONS /wp-json/wp/v2/posts and inspects
 * `schema.properties.meta.properties` keys. We require the EXACT description
 * key to be registered (writable over REST), not merely the plugin namespace:
 * - `_yoast_wpseo_metadesc` present → "yoast"
 * - `rank_math_description` present → "rankmath"
 * - otherwise                       → null
 *
 * Yoast registers several `_yoast_wpseo_*` keys for REST but `_yoast_wpseo_metadesc`
 * itself is frequently a protected key that is NOT writable — claiming "yoast"
 * off the prefix and then sending that key 400s the whole publish request.
 */
export async function detectSeoPlugin(env: Env): Promise<SeoPlugin | null> {
  if (!env.WP_BASE_URL) throw new Error("WP_BASE_URL is required");

  const baseUrl = env.WP_BASE_URL.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (env.WP_USERNAME && env.WP_APP_PASSWORD) {
    headers["Authorization"] = buildAuthHeader(env.WP_USERNAME, env.WP_APP_PASSWORD);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/wp-json/wp/v2/posts`, {
      method: "OPTIONS",
      headers,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    throw new WordPressError(
      `transport_error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const snippet = await resp.text();
    throw new WordPressError(`${resp.status}: ${snippet.slice(0, 500)}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const schema = (data["schema"] as Record<string, unknown> | undefined) ?? {};
  const properties = (schema["properties"] as Record<string, unknown> | undefined) ?? {};
  const metaProps =
    ((properties["meta"] as Record<string, unknown> | undefined)?.["properties"] as
      | Record<string, unknown>
      | undefined) ?? {};

  const keys = Object.keys(metaProps);
  if (keys.includes("_yoast_wpseo_metadesc")) return "yoast";
  if (keys.includes("rank_math_description")) return "rankmath";
  return null;
}

// ---------------------------------------------------------------------------
// Target label
// ---------------------------------------------------------------------------

/** Expose the WP_TARGET env var — surfaced by the dry-publish endpoint. */
export function getTargetLabel(env: Env): string | undefined {
  return env.WP_TARGET;
}
