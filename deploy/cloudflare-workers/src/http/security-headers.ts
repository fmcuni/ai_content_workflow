// ---------------------------------------------------------------------------
// Shared security headers (CSP + hardening) for the Workers backend.
//
// Applied to every response by the `securityHeaders` Hono middleware in
// src/index.ts. Kept BYTE-IN-SYNC with the web surface's policy
// (web/lib/security-headers.ts) so both surfaces present one consistent CSP.
//
// CSP NOTE — `script-src 'unsafe-inline'`: this backend serves JSON/SSE, not
// HTML with inline scripts, but the policy mirrors the web surface for
// consistency (a single auditable policy string). We NEVER use `'unsafe-eval'`.
// `connect-src` covers same-origin, the Supabase Auth (GoTrue) endpoint, and
// the cross-origin SSE/REST + collab WebSocket on `*.fmc.workers.dev`.
//
// STREAMING / WEBSOCKET SAFETY: the middleware stamps these headers by mutating
// the existing response's `Headers` in place — it does NOT re-wrap the body, so
// the SSE `text/event-stream` body stream is preserved. WebSocket-upgrade (101)
// responses are skipped entirely so their `webSocket` handle is never dropped.
// ---------------------------------------------------------------------------

/** The Content-Security-Policy value. Keep in sync with web/lib/security-headers.ts. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co https://*.fmc.workers.dev wss://*.fmc.workers.dev",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/** The full security-header set applied to every (non-WebSocket-upgrade) response. */
export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Content-Security-Policy", CONTENT_SECURITY_POLICY],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  // Internal tool — never index, follow, cache, or snippet any response.
  ["X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet"],
];

/**
 * Stamp the security headers onto an existing response's `Headers` IN PLACE.
 * Mutating the existing `Headers` (rather than re-wrapping the `Response`)
 * keeps streaming bodies (SSE) and the WebSocket `webSocket` handle intact.
 */
export function applySecurityHeaders(headers: Headers): void {
  for (const [key, value] of SECURITY_HEADERS) {
    headers.set(key, value);
  }
}

/**
 * A WebSocket-upgrade response must be returned untouched — re-wrapping it (or
 * in some runtimes even reading `.headers`) drops the `webSocket` handle and
 * breaks the 101 handshake. Detect it by the `webSocket` property or the 101
 * status so the middleware can skip it.
 */
export function isWebSocketUpgrade(res: Response): boolean {
  return res.status === 101 || (res as { webSocket?: unknown }).webSocket != null;
}
