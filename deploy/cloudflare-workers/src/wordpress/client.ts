import type { Env } from "../index";
import { stripAnchorSpans } from "../util/strip_anchors";
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
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const READBACK_FIELDS = "id,link,status,slug,modified_gmt";

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
// Resilience types
// ---------------------------------------------------------------------------

/** Tunable retry/backoff knobs; defaulted so `new WordPressClient(env)` works unchanged. */
export interface WordPressClientOptions {
  maxAttempts?: number;
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** A post resolved by the slug read-back gate. */
export interface ReadbackPost {
  id: number;
  link: string;
  status: string;
  slug: string;
  modifiedGmt: string;
}

/** Discriminated result of `findPostBySlug`. */
export type ReadbackResult =
  | { kind: "found"; post: ReadbackPost }
  | { kind: "not_found" }
  | { kind: "unknown" };

/**
 * Outcome of a single publish HTTP attempt, classified on transport outcome +
 * status + content-type — never on body content (infra strips WP error bodies).
 */
type PublishOutcome =
  | { kind: "success"; result: PublishResult }
  | { kind: "conflict"; message: string }
  | { kind: "wp_reject"; message: string }
  | { kind: "retriable"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the Basic Auth header value from username + app password. */
function buildAuthHeader(username: string, appPassword: string): string {
  return `Basic ${btoa(`${username}:${appPassword}`)}`;
}

/** Build a diagnosable non-JSON description from status + headers + byte length. */
function nonJsonDiagnosis(status: number, headers: Headers, bodyLength: number): string {
  const ctype = headers.get("content-type") ?? "";
  const xCache = headers.get("x-cache") ?? null;
  return (
    `WP REST returned non-JSON response (${status} ${ctype || "no content-type"}, ` +
    `${bodyLength} bytes, x-cache=${JSON.stringify(xCache)}) — likely a ` +
    `CloudFront/origin outage.`
  );
}

/** True when the response advertises a JSON content-type and has a non-empty body. */
function isJsonBody(headers: Headers, bodyLength: number): boolean {
  const ctype = headers.get("content-type") ?? "";
  return ctype.toLowerCase().startsWith("application/json") && bodyLength > 0;
}

/** Parse a string as JSON, narrowing failures to null instead of throwing. */
function tryParseJson(rawText: string): unknown {
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return null;
  }
}

/** Build the public PublishResult shape from a parsed WP post object. */
function toPublishResult(data: Record<string, unknown>): PublishResult {
  return {
    id: data["id"] as number,
    link: data["link"] as string,
    status: data["status"] as string,
    modifiedGmt: data["modified_gmt"] as string,
    slug: data["slug"] as string,
  };
}

/** Re-key a read-back post into the WP `modified_gmt` shape `toPublishResult` expects. */
function toReadbackData(post: ReadbackPost): Record<string, unknown> {
  return {
    id: post.id,
    link: post.link,
    status: post.status,
    modified_gmt: post.modifiedGmt,
    slug: post.slug,
  };
}

/**
 * Build the immutable publish request body from the payload. The `template`
 * key is omitted entirely when null (leave existing post template untouched);
 * `""` forces the WP default theme template.
 */
function buildPublishBody(p: PublishPayload): Readonly<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    title: p.title,
    // Strip editor annotation anchors (comment/review spans) — they are
    // in-document markers, never article content. This is the authoritative
    // chokepoint: every real publish (HITL_2 + republish) funnels through here.
    content: stripAnchorSpans(p.content),
    status: p.status,
    categories: p.categories,
    tags: p.tags,
    meta: p.meta,
  };
  return {
    ...base,
    ...(p.template !== null ? { template: p.template } : {}),
    ...(p.excerpt !== null ? { excerpt: p.excerpt } : {}),
    ...(p.slug !== null ? { slug: p.slug } : {}),
    ...(p.author !== null ? { author: p.author } : {}),
    ...(p.featuredMedia !== null ? { featured_media: p.featuredMedia } : {}),
    ...(p.dateGmt !== null ? { date_gmt: stripTzSuffix(p.dateGmt) } : {}),
  };
}

/**
 * Classify a publish HTTP response per the spec's outcome table. Decisions use
 * only transport outcome + status + content-type — never body content, because
 * the infra layer strips WP's own JSON error bodies on failure.
 *
 * - SUCCESS:   2xx + JSON content-type + parseable JSON body
 * - CONFLICT:  HTTP 412 (genuine optimistic-lock conflict) — no retry
 * - WP_REJECT: 4xx (not 412) with a parseable JSON body (deterministic) — no retry
 * - RETRIABLE: transport/5xx/412-excluded, OR any non-JSON / unparseable body
 *              at any status (an infra block, which is transient)
 */
function classifyResponse(status: number, headers: Headers, rawText: string): PublishOutcome {
  if (status === 412) {
    return { kind: "conflict", message: rawText.slice(0, 500) || "412 conflict" };
  }

  // Any non-JSON / empty body ⇒ infra block ⇒ RETRIABLE, regardless of status.
  if (!isJsonBody(headers, rawText.length)) {
    return { kind: "retriable", message: nonJsonDiagnosis(status, headers, rawText.length) };
  }

  const parsed = tryParseJson(rawText);
  if (parsed === null || typeof parsed !== "object") {
    // Claimed application/json but truncated/unparseable ⇒ treat as infra block.
    return { kind: "retriable", message: nonJsonDiagnosis(status, headers, rawText.length) };
  }

  const data = parsed as Record<string, unknown>;

  if (status >= 200 && status < 300) {
    return { kind: "success", result: toPublishResult(data) };
  }

  if (status >= 400 && status < 500) {
    const wpMessage = typeof data["message"] === "string" ? data["message"] : rawText.slice(0, 500);
    return { kind: "wp_reject", message: `${status}: ${wpMessage}` };
  }

  // 5xx or 3xx with a JSON body — still transient.
  return { kind: "retriable", message: `${status}: ${rawText.slice(0, 500)}` };
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
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(env: Env, opts?: WordPressClientOptions) {
    if (!env.WP_BASE_URL) throw new Error("WP_BASE_URL is required");
    if (!env.WP_USERNAME) throw new Error("WP_USERNAME is required");
    if (!env.WP_APP_PASSWORD) throw new Error("WP_APP_PASSWORD is required");

    this.baseUrl = env.WP_BASE_URL.replace(/\/$/, "");
    this.username = env.WP_USERNAME;
    this.appPassword = env.WP_APP_PASSWORD;
    this.maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffBaseMs = opts?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.sleep = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  // -------------------------------------------------------------------------
  // upsert
  // -------------------------------------------------------------------------

  async upsert(p: PublishPayload): Promise<PublishResult> {
    const isCreate = p.postId === null;
    let lastFailure = "no attempt was made";

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const outcome = await this.attemptPublish(p);

      if (outcome.kind === "success") return outcome.result;
      if (outcome.kind === "conflict") throw new WordPressConflictError(outcome.message);
      if (outcome.kind === "wp_reject") throw new WordPressError(outcome.message);

      // outcome.kind === "retriable"
      lastFailure = outcome.message;
      const isFinalAttempt = attempt >= this.maxAttempts;

      if (isCreate) {
        // POST is NOT idempotent — gate every retry behind a slug read-back so a
        // blocked-but-landed create never double-publishes.
        const gated = await this.gateCreateRetry(p, outcome.message);
        if (gated.kind === "found") return toPublishResult(toReadbackData(gated.post));
        if (gated.kind === "stop") throw new WordPressError(gated.message);
        // gated.kind === "retry" → fall through to next POST attempt
      }

      if (isFinalAttempt) {
        throw new WordPressError(
          `WP publish failed after ${this.maxAttempts} attempts: ${lastFailure}`,
        );
      }
      await this.sleep(this.backoffBaseMs * 2 ** (attempt - 1));
    }

    // Unreachable: the loop either returns or throws. Defensive throw for the type checker.
    throw new WordPressError(`WP publish failed: ${lastFailure}`);
  }

  /**
   * Decide whether a create (POST) may be retried after a retriable outcome.
   * - FOUND   → the create already landed (response was blocked); return it.
   * - retry   → proven absent → safe to POST again.
   * - stop    → cannot prove absence (no slug / inconclusive read-back) → fail loudly.
   */
  private async gateCreateRetry(
    p: PublishPayload,
    failure: string,
  ): Promise<
    { kind: "found"; post: ReadbackPost } | { kind: "retry" } | { kind: "stop"; message: string }
  > {
    if (p.slug === null || p.slug === "") {
      return {
        kind: "stop",
        message:
          `WP create failed and could not be retried: read-back was impossible ` +
          `because no slug was supplied (cannot prove a duplicate was not created). ` +
          `Last failure: ${failure}`,
      };
    }

    const readback = await this.findPostBySlug(p.slug);
    if (readback.kind === "found") return { kind: "found", post: readback.post };
    if (readback.kind === "not_found") return { kind: "retry" };
    // kind === "unknown"
    return {
      kind: "stop",
      message:
        `WP create failed and the slug read-back was inconclusive (read-back blocked); ` +
        `not retrying to avoid a duplicate post. Last failure: ${failure}`,
    };
  }

  /** Issue one publish request and classify its outcome (no retries here). */
  private async attemptPublish(p: PublishPayload): Promise<PublishOutcome> {
    const headers: Record<string, string> = {
      Authorization: buildAuthHeader(this.username, this.appPassword),
      "Content-Type": "application/json",
    };
    if (p.ifUnmodifiedSince) {
      headers["If-Unmodified-Since"] = p.ifUnmodifiedSince;
    }

    const body = buildPublishBody(p);
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
      // transport error / timeout / abort → RETRIABLE
      return {
        kind: "retriable",
        message: `transport_error: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    const rawText = await resp.text();
    return classifyResponse(resp.status, resp.headers, rawText);
  }

  // -------------------------------------------------------------------------
  // findPostBySlug — read-back gate
  // -------------------------------------------------------------------------

  /**
   * Authenticated slug read-back used to gate create retries.
   * Queries GET /wp/v2/posts?slug=<slug>&status=any&_fields=... so non-published
   * (e.g. draft) creates are visible. A non-JSON / transport-failed read-back
   * maps to `{ kind: "unknown" }` and never throws out of the gate.
   */
  async findPostBySlug(slug: string): Promise<ReadbackResult> {
    const params = new URLSearchParams({
      slug,
      status: "any",
      _fields: READBACK_FIELDS,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts?${params.toString()}`, {
        headers: { Authorization: buildAuthHeader(this.username, this.appPassword) },
        signal: controller.signal,
      });
    } catch {
      return { kind: "unknown" };
    } finally {
      clearTimeout(timer);
    }

    const rawText = await resp.text();
    if (!resp.ok || !isJsonBody(resp.headers, rawText.length)) {
      return { kind: "unknown" };
    }

    const parsed = tryParseJson(rawText);
    if (!Array.isArray(parsed)) return { kind: "unknown" };
    if (parsed.length === 0) return { kind: "not_found" };

    const first = parsed[0] as Record<string, unknown>;
    return {
      kind: "found",
      post: {
        id: first["id"] as number,
        link: first["link"] as string,
        status: first["status"] as string,
        slug: first["slug"] as string,
        modifiedGmt: first["modified_gmt"] as string,
      },
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
