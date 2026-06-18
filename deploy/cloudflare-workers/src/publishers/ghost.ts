// Ghost (Pro) Admin API publisher. Mirrors the role of WordPressClient.upsert
// for a `kind='ghost'` publish target. Authenticates with a short-lived HS256
// JWT minted from the Admin API key ('{id}:{secret}'), creates a post from HTML
// (?source=html), or updates an existing one with optimistic concurrency
// (updated_at → 409 on conflict). Carries the WordPress-parity metadata set:
// authors (by staff id), tags (by name, auto-created), feature image (URL),
// custom excerpt, SEO meta_title/meta_description, slug, and a 3-state status
// (draft / scheduled / published) with published_at. Also exposes read-only
// listAuthors()/listTags() so the HITL_2 pickers can populate live. Out of
// scope (deferred): visibility, featured flag, canonical/OG/Twitter overrides.
import { wrapNonNativeHtmlForGhost } from "./ghost_html";

const TOKEN_TTL_SECONDS = 300;
const DEFAULT_ACCEPT_VERSION = "v6.0";

/** Resolved Ghost credentials for a target — read from env, never persisted. */
export interface GhostCreds {
  // Ghost site URL or full admin API URL; normalised to the admin base.
  apiUrl: string;
  // Admin API key, '{id}:{secret}' (secret is hex). Never logged.
  adminKey: string;
}

export interface GhostPublishPayload {
  // Existing Ghost post id (UUID) for an update, or null to create a new draft.
  postId: string | null;
  title: string;
  // Article HTML body (our renderer output). Card-fenced before sending.
  html: string;
  slug: string | null;
  // WordPress-style status from resolvePublishStatus ("publish" | "draft" |
  // "future"); mapped to Ghost's "published" | "draft" | "scheduled".
  status: string;
  excerpt: string | null;
  // WordPress-parity metadata (all optional; omitted fields are left untouched).
  // Ghost staff-user ids → post authors. First id is the primary author.
  authorIds?: string[] | null;
  // Tag names; Ghost matches existing tags by name and auto-creates new ones.
  tags?: string[] | null;
  // Absolute feature-image URL (Ghost has no numeric media id).
  featureImage?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  // Raw HTML injected into the Ghost post's <head> (codeinjection_head); used to
  // ship FAQ JSON-LD structured data as <script type="application/ld+json"> tags.
  codeInjectionHead?: string | null;
  // ISO-8601 publish timestamp; required by Ghost when status="scheduled".
  publishedAt?: string | null;
}

/** A Ghost staff user that can author posts — feeds the HITL_2 author picker. */
export interface GhostAuthorOption {
  id: string;
  name: string;
  slug: string;
}

/** A public Ghost tag — feeds the HITL_2 tag combobox. */
export interface GhostTagOption {
  name: string;
  slug: string;
}

export interface GhostPublishResult {
  // Ghost post UUID — a string, unlike WordPress's integer id.
  id: string;
  link: string;
  status: string;
  slug: string;
}

/** A Ghost post resolved by slug — feeds the fetch_article refresh path so a
 * Ghost-target refresh can UPDATE the existing, externally-authored post. */
export interface GhostFetchedPost {
  id: string;
  slug: string;
  url: string;
  title: string;
  html: string;
}

/** Thrown when an update is rejected for a stale `updated_at` (HTTP 409). */
export class GhostConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhostConflictError";
  }
}

interface GhostPublisherOptions {
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
  // Injectable clock (seconds) for deterministic JWT tests.
  nowSeconds?: () => number;
  acceptVersion?: string;
}

interface GhostPostResponse {
  id: string;
  uuid?: string;
  url?: string;
  slug?: string;
  status?: string;
  updated_at?: string;
  // Returned by the Admin API when reading with ?formats=html.
  title?: string;
  html?: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("Ghost admin key secret is not valid hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToB64Url(s: string): string {
  return bytesToB64Url(new TextEncoder().encode(s));
}

/**
 * Render JSON-LD graph pieces (e.g. FAQPage) as Ghost head code-injection
 * `<script type="application/ld+json">` tags. Ghost emits codeinjection_head
 * into the page <head>, so this is how structured data reaches a Ghost post
 * (the WordPress path ships the same graph via the _bowtie_schema_jsonld post
 * meta key). Returns null for an empty/absent graph so callers omit the field.
 */
export function buildGhostSchemaHead(schema: object[] | null): string | null {
  if (schema === null || schema.length === 0) return null;
  return schema
    .map((piece) => `<script type="application/ld+json">${JSON.stringify(piece)}</script>`)
    .join("\n");
}

/** Normalise a Ghost site / API URL to its admin base ({site}/ghost/api/admin). */
export function ghostAdminBase(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    throw new Error("Ghost target requires a non-empty API URL");
  }
  return trimmed.includes("/ghost/api")
    ? trimmed.replace(/\/ghost\/api.*$/, "/ghost/api/admin")
    : `${trimmed}/ghost/api/admin`;
}

/** Map a WordPress-style publish status to Ghost's vocabulary. */
function toGhostStatus(wpStatus: string): "published" | "draft" | "scheduled" {
  if (wpStatus === "publish" || wpStatus === "published") return "published";
  // WordPress's "future" (scheduled) maps to Ghost's "scheduled"; the caller
  // must supply a future publishedAt or Ghost rejects the request.
  if (wpStatus === "future" || wpStatus === "scheduled") return "scheduled";
  return "draft";
}

/**
 * Mint a Ghost Admin API JWT (HS256, kid=id, aud=/admin/, 5-min expiry) from a
 * '{id}:{secret}' admin key. The secret is hex-decoded per Ghost's spec.
 */
export async function ghostAdminToken(adminKey: string, nowSeconds: number): Promise<string> {
  const idx = adminKey.indexOf(":");
  if (idx === -1) {
    throw new Error("Ghost admin key must be in '{id}:{secret}' form");
  }
  const id = adminKey.slice(0, idx);
  const secret = adminKey.slice(idx + 1);
  const header = textToB64Url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const payload = textToB64Url(
    JSON.stringify({ iat: nowSeconds, exp: nowSeconds + TOKEN_TTL_SECONDS, aud: "/admin/" }),
  );
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${bytesToB64Url(new Uint8Array(sig))}`;
}

/** Minimal shapes for the Admin API read endpoints we consume. */
interface GhostUserRow {
  id: string;
  name?: string;
  slug?: string;
}
interface GhostTagRow {
  name?: string;
  slug?: string;
  visibility?: string;
}
interface GhostApiResponse {
  posts?: GhostPostResponse[];
  users?: GhostUserRow[];
  tags?: GhostTagRow[];
}

export class GhostPublisher {
  private readonly creds: GhostCreds;
  private readonly fetchImpl: typeof fetch;
  private readonly nowSeconds: () => number;
  private readonly acceptVersion: string;

  constructor(creds: GhostCreds, opts: GhostPublisherOptions = {}) {
    this.creds = creds;
    // The global `fetch` must be invoked with `this === globalThis`. Storing it
    // bare and calling `this.fetchImpl(...)` rebinds the receiver to this
    // instance, which workerd rejects with "Illegal invocation". Bind it (or
    // keep an injected test double as-is).
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.acceptVersion = opts.acceptVersion ?? DEFAULT_ACCEPT_VERSION;
  }

  /** Create a new draft or update an existing post; returns the Ghost result. */
  async upsert(payload: GhostPublishPayload): Promise<GhostPublishResult> {
    return payload.postId === null || payload.postId === ""
      ? this.create(payload)
      : this.update(payload.postId, payload);
  }

  /** List staff users that can author posts (feeds the HITL_2 author picker). */
  async listAuthors(): Promise<GhostAuthorOption[]> {
    const res = await this.request("GET", "/users/", undefined, "?limit=all");
    if (!res.ok) {
      throw new Error(`Ghost list authors failed (${res.status}): ${res.text.slice(0, 300)}`);
    }
    return (res.json?.users ?? []).map((u) => ({
      id: u.id,
      name: u.name ?? "",
      slug: u.slug ?? "",
    }));
  }

  /** List public tags (feeds the HITL_2 tag combobox). Internal `#` tags are
   * excluded — they're not editorially selectable. */
  async listTags(): Promise<GhostTagOption[]> {
    const res = await this.request("GET", "/tags/", undefined, "?limit=all");
    if (!res.ok) {
      throw new Error(`Ghost list tags failed (${res.status}): ${res.text.slice(0, 300)}`);
    }
    return (res.json?.tags ?? [])
      .filter((t) => (t.visibility ?? "public") !== "internal" && !(t.name ?? "").startsWith("#"))
      .map((t) => ({ name: t.name ?? "", slug: t.slug ?? "" }));
  }

  /**
   * Read a post by slug (with its HTML body) — used by the fetch_article
   * refresh path so a Ghost-target refresh learns the real post id/slug/html
   * instead of scraping the live page. Returns null when the post does not
   * exist (404 or any non-ok response with no post in the payload).
   */
  async fetchPostBySlug(slug: string): Promise<GhostFetchedPost | null> {
    const res = await this.request(
      "GET",
      `/posts/slug/${encodeURIComponent(slug)}/`,
      undefined,
      "?formats=html",
    );
    const post = res.json?.posts?.[0];
    if (!res.ok || post === undefined) return null;
    return {
      id: post.id,
      slug: post.slug ?? slug,
      url: post.url ?? "",
      title: post.title ?? "",
      html: post.html ?? "",
    };
  }

  /** Upload an image to Ghost's image store; returns the hosted URL (used as a
   * post feature_image). Multipart — the boundary is set by FormData, so we do
   * NOT set Content-Type here. */
  async uploadImage(file: File): Promise<string> {
    const token = await ghostAdminToken(this.creds.adminKey, this.nowSeconds());
    const form = new FormData();
    form.append("file", file, file.name !== "" ? file.name : "upload");
    form.append("purpose", "image");
    const url = `${ghostAdminBase(this.creds.apiUrl)}/images/upload/`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Ghost ${token}`, "Accept-Version": this.acceptVersion },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Ghost image upload failed (${res.status}): ${text.slice(0, 300)}`);
    }
    let json: { images?: { url?: string }[] } | null = null;
    try {
      json = JSON.parse(text) as { images?: { url?: string }[] };
    } catch {
      json = null;
    }
    const uploaded = json?.images?.[0]?.url;
    if (uploaded === undefined || uploaded === "") {
      throw new Error("Ghost image upload returned no url");
    }
    return uploaded;
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    query = "",
  ): Promise<{ status: number; ok: boolean; json: GhostApiResponse | null; text: string }> {
    const token = await ghostAdminToken(this.creds.adminKey, this.nowSeconds());
    const url = `${ghostAdminBase(this.creds.apiUrl)}${path}${query}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Ghost ${token}`,
        "Content-Type": "application/json",
        "Accept-Version": this.acceptVersion,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: GhostApiResponse | null = null;
    try {
      json = JSON.parse(text) as GhostApiResponse;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  }

  private toResult(post: GhostPostResponse): GhostPublishResult {
    return {
      id: post.id,
      link: post.url ?? "",
      status: post.status ?? "",
      slug: post.slug ?? "",
    };
  }

  private postBody(payload: GhostPublishPayload, updatedAt?: string): Record<string, unknown> {
    const post: Record<string, unknown> = {
      title: payload.title,
      html: wrapNonNativeHtmlForGhost(payload.html),
      status: toGhostStatus(payload.status),
    };
    if (payload.slug !== null && payload.slug !== "") post["slug"] = payload.slug;
    if (payload.excerpt !== null && payload.excerpt !== "") post["custom_excerpt"] = payload.excerpt;
    // WordPress-parity metadata. Each is sent only when supplied so an update
    // never blanks a field the operator left untouched.
    if (payload.authorIds && payload.authorIds.length > 0) {
      post["authors"] = payload.authorIds.map((id) => ({ id }));
    }
    if (payload.tags && payload.tags.length > 0) {
      post["tags"] = payload.tags.map((name) => ({ name }));
    }
    if (payload.featureImage !== null && payload.featureImage !== undefined && payload.featureImage !== "") {
      post["feature_image"] = payload.featureImage;
    }
    if (payload.metaTitle !== null && payload.metaTitle !== undefined && payload.metaTitle !== "") {
      post["meta_title"] = payload.metaTitle;
    }
    if (
      payload.metaDescription !== null &&
      payload.metaDescription !== undefined &&
      payload.metaDescription !== ""
    ) {
      post["meta_description"] = payload.metaDescription;
    }
    if (
      payload.codeInjectionHead !== null &&
      payload.codeInjectionHead !== undefined &&
      payload.codeInjectionHead !== ""
    ) {
      post["codeinjection_head"] = payload.codeInjectionHead;
    }
    if (payload.publishedAt !== null && payload.publishedAt !== undefined && payload.publishedAt !== "") {
      post["published_at"] = payload.publishedAt;
    }
    if (updatedAt !== undefined) post["updated_at"] = updatedAt;
    return { posts: [post] };
  }

  private async create(payload: GhostPublishPayload): Promise<GhostPublishResult> {
    // POST is NOT idempotent: if the request is blocked/times out AFTER Ghost
    // created the post, a naive retry duplicates it. Mirror WordPressClient's
    // gateCreateRetry — on failure, do a SINGLE slug read-back; if a post with
    // that slug now exists the create already landed, so return it instead of
    // letting the caller retry into a duplicate. Without a slug we can't safely
    // dedupe, so we rethrow as before.
    let createError: unknown;
    try {
      const res = await this.request("POST", "/posts/", this.postBody(payload), "?source=html");
      const post = res.json?.posts?.[0];
      if (res.ok && post !== undefined) return this.toResult(post);
      createError = new Error(`Ghost create failed (${res.status}): ${res.text.slice(0, 400)}`);
    } catch (err: unknown) {
      createError = err;
    }

    if (payload.slug !== null && payload.slug !== "") {
      const existing = await this.fetchPostBySlug(payload.slug);
      if (existing !== null) {
        return {
          id: existing.id,
          link: existing.url,
          status: toGhostStatus(payload.status),
          slug: existing.slug,
        };
      }
    }
    throw createError instanceof Error
      ? createError
      : new Error(`Ghost create failed: ${String(createError)}`);
  }

  private async update(postId: string, payload: GhostPublishPayload): Promise<GhostPublishResult> {
    // Ghost requires the current updated_at for optimistic concurrency.
    const current = await this.request("GET", `/posts/${postId}/`, undefined, "?formats=html");
    const existing = current.json?.posts?.[0];
    if (!current.ok || existing === undefined) {
      throw new Error(`Ghost read-before-update failed (${current.status}): ${current.text.slice(0, 400)}`);
    }
    const res = await this.request(
      "PUT",
      `/posts/${postId}/`,
      this.postBody(payload, existing.updated_at),
      "?source=html",
    );
    if (res.status === 409) {
      throw new GhostConflictError(
        `Ghost post ${postId} changed since it was loaded (409 conflict)`,
      );
    }
    const post = res.json?.posts?.[0];
    if (!res.ok || post === undefined) {
      throw new Error(`Ghost update failed (${res.status}): ${res.text.slice(0, 400)}`);
    }
    return this.toResult(post);
  }
}

/**
 * Read a Ghost target's credentials from env under its auth_ref prefix
 * ({ref}_API_URL / {ref}_ADMIN_API_KEY). Read in the running Worker, never
 * persisted. Throws when a required env var is absent.
 */
export function buildGhostCreds(
  env: Record<string, string | undefined>,
  authRef: string | null,
): GhostCreds {
  if (authRef === null || authRef === "") {
    throw new Error("Ghost publish target requires an auth_ref");
  }
  const get = (key: string): string => {
    const value = env[key];
    if (!value) {
      throw new Error(`publish target requires env var ${key}, which is not set`);
    }
    return value;
  };
  return { apiUrl: get(`${authRef}_API_URL`), adminKey: get(`${authRef}_ADMIN_API_KEY`) };
}
