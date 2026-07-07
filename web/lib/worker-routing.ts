// ---------------------------------------------------------------------------
// Pure route-classification logic for the custom Worker entry (worker-entry.mjs).
//
// Every app page is prerendered at build time (see
// web/scripts/materialize-prerender.mjs) — but every request was still
// entering OpenNext's full Next server handler, costing 20-250ms of CPU on
// the free plan's 10ms cap. This module decides, BEFORE paying that cost,
// whether a request can be answered directly (crawler 403, static-asset 404,
// `/api/*` proxy, or a prerendered HTML file) or must fall through to the
// real Next handler (RSC/client-nav requests, POSTs, unknown routes).
//
// Kept dependency-free (no `next/server`, no Cloudflare types) so it is
// trivially unit-testable and importable from both the Worker entry and
// vitest.
// ---------------------------------------------------------------------------

import { isKnownCrawler } from "./crawler-ua";

/** Mirrors middleware.ts PUBLIC_PATHS — pages reachable without a session cookie. */
export const PUBLIC_PATHS = ["/login", "/signup", "/verify"];

/** Mirrors middleware.ts SUPABASE_COOKIE_NAME. */
export const SUPABASE_COOKIE_NAME = "bowtie-sb-auth";

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Optimistic session-cookie presence check from a raw `Cookie` header string.
 * Mirrors middleware.ts hasSessionCookie(), which uses NextRequest's parsed
 * cookie jar — this is the raw-header equivalent for the Worker fast path.
 */
export function hasSessionCookieHeader(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  const names = [`${SUPABASE_COOKIE_NAME}.0`, SUPABASE_COOKIE_NAME];
  return cookieHeader.split(";").some((part) => {
    const eq = part.indexOf("=");
    if (eq === -1) return false;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    return names.includes(name) && value.length > 0;
  });
}

// ---------------------------------------------------------------------------
// /api/* proxy mapping — mirrors next.config.mjs rewrites() EXACTLY. Keep the
// two in sync; next.config's rewrites() stays in place as a fallback for any
// request that reaches the Next handler directly (e.g. local `next dev`).
// ---------------------------------------------------------------------------

/** Exact (bare-collection) rules. Checked before the prefix rules. */
const API_EXACT_MAP: Readonly<Record<string, string>> = {
  // Path-preserving special case — keeps the `/api` prefix (see next.config.mjs).
  "/api/auth-ticket": "/api/auth-ticket",
  "/api/setup": "/setup",
  "/api/runs": "/runs",
  "/api/health": "/health",
  "/api/articles": "/articles",
  "/api/refresh": "/refresh",
  "/api/personas": "/personas",
  "/api/publish-targets": "/publish-targets",
  "/api/prompts": "/prompts",
  "/api/source-policy": "/source-policy",
  "/api/topic-batches": "/topic-batches",
  "/api/me": "/me",
};

/** `:path*` prefix rules — `/api/<prefix>/...` -> `<destPrefix>/...`. */
const API_PREFIX_MAP: ReadonlyArray<{ prefix: string; destPrefix: string }> = [
  { prefix: "/api/setup", destPrefix: "/setup" },
  { prefix: "/api/runs", destPrefix: "/runs" },
  { prefix: "/api/costs", destPrefix: "/costs" },
  { prefix: "/api/articles", destPrefix: "/articles" },
  { prefix: "/api/refresh", destPrefix: "/refresh" },
  { prefix: "/api/wp-options", destPrefix: "/wp-options" },
  { prefix: "/api/ghost-options", destPrefix: "/ghost-options" },
  { prefix: "/api/media", destPrefix: "/media" },
  { prefix: "/api/personas", destPrefix: "/personas" },
  { prefix: "/api/publish-targets", destPrefix: "/publish-targets" },
  { prefix: "/api/prompts", destPrefix: "/prompts" },
  { prefix: "/api/source-policy", destPrefix: "/source-policy" },
  { prefix: "/api/topic-batches", destPrefix: "/topic-batches" },
  { prefix: "/api/admin", destPrefix: "/admin" },
];

/**
 * Maps an `/api/*` pathname to a full backend URL, or `null` if it doesn't
 * match any rewrite rule (unmapped `/api/*` paths fall through to `delegate`,
 * matching next.config.mjs behavior of leaving them unrewritten).
 */
export function mapApiTarget(pathname: string, apiBase: string): string | null {
  const exact = API_EXACT_MAP[pathname];
  if (exact) return `${apiBase}${exact}`;

  for (const { prefix, destPrefix } of API_PREFIX_MAP) {
    if (pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length);
      return `${apiBase}${destPrefix}${rest}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prerendered-route lookup
// ---------------------------------------------------------------------------

/** Normalizes a pathname to the key used in PRERENDERED (strip trailing slash, "" -> "/"). */
export function normalizeRoute(pathname: string): string {
  if (pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function isPrerenderedRoute(pathname: string, prerendered: ReadonlySet<string>): boolean {
  return prerendered.has(normalizeRoute(pathname));
}

// ---------------------------------------------------------------------------
// Top-level classification
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  method: string;
  pathname: string;
  userAgent: string | null;
  cookieHeader: string | null;
  /** True when the request carries Next's `rsc` header (client navigation / data fetch). */
  isRscRequest: boolean;
  prerenderedRoutes: ReadonlySet<string>;
  apiBase: string;
  /** Raw `url.search` (e.g. `"?run_id=abc"`, `""` when absent). */
  search: string;
}

export type RouteDecision =
  | { type: "crawler-403" }
  | { type: "static-miss-404" }
  | { type: "api-proxy"; target: string }
  | { type: "redirect-login"; location: string }
  | { type: "prerender-hit"; route: string }
  | { type: "delegate" };

export function classifyRequest(input: ClassifyInput): RouteDecision {
  if (isKnownCrawler(input.userAgent)) {
    return { type: "crawler-403" };
  }

  if (input.pathname.startsWith("/_next/static/")) {
    return { type: "static-miss-404" };
  }

  // The materialized shells under /__prerender/ are an internal detail served
  // via env.ASSETS.fetch — direct requests 404 (wrangler.jsonc run_worker_first
  // routes them here instead of asset-first serving, which would bypass the
  // crawler 403 above and the cookie gate below).
  if (input.pathname.startsWith("/__prerender/")) {
    return { type: "static-miss-404" };
  }

  const apiTarget = mapApiTarget(input.pathname, input.apiBase);
  if (apiTarget) {
    return { type: "api-proxy", target: apiTarget + input.search };
  }

  const isDocumentRequest =
    (input.method === "GET" || input.method === "HEAD") && !input.isRscRequest;
  if (isDocumentRequest && isPrerenderedRoute(input.pathname, input.prerenderedRoutes)) {
    const route = normalizeRoute(input.pathname);
    if (!isPublicPath(route) && !hasSessionCookieHeader(input.cookieHeader)) {
      return {
        type: "redirect-login",
        location: `/login?redirect=${encodeURIComponent(route)}`,
      };
    }
    return { type: "prerender-hit", route };
  }

  return { type: "delegate" };
}
