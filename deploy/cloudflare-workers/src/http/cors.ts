// ---------------------------------------------------------------------------
// CORS for browser-direct SSE streams.
//
// REST calls reach this backend through the frontend's same-origin `/api/*`
// rewrite proxy (server-to-server, no CORS needed). The SSE streams
// (`/runs/:id/events`, `/topic-batches/:id/events`) are different: the browser
// opens them DIRECTLY against this Worker, because Next.js rewrites buffer the
// response body and break streaming (see web/lib/sse.ts). So those stream
// responses — and their preflight — must carry CORS headers.
//
// `FRONTEND_ORIGIN` is a comma-separated allowlist pinning the permitted
// origin(s) in production. It MUST be set per environment. We fail CLOSED: when
// `FRONTEND_ORIGIN` is unset/empty we do NOT reflect the request `Origin` and do
// NOT fall back to `*` (that would allow any site to read these streams). Instead
// `resolveCorsOrigin` returns "" and `corsHeaders` omits the
// `Access-Control-Allow-Origin` header entirely, so the browser denies the
// cross-origin read. Configured origins keep working unchanged (echoed when on
// the allowlist, otherwise pinned to the first allowlisted origin).
// ---------------------------------------------------------------------------

// Warn at most once per isolate so an unset allowlist is visible in logs without
// spamming on every request.
let warnedMissingAllowlist = false;

/**
 * Resolve the `Access-Control-Allow-Origin` value for a cross-origin request.
 *
 * Returns "" (empty) when no allowlist is configured — callers treat that as
 * "omit the header" (fail closed). Never reflects an arbitrary origin and never
 * falls back to `*`.
 */
export function resolveCorsOrigin(
  requestOrigin: string | null,
  allowlist: string | undefined,
): string {
  const allowed = (allowlist ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (allowed.length === 0) {
    if (!warnedMissingAllowlist) {
      warnedMissingAllowlist = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[cors] FRONTEND_ORIGIN is unset/empty; failing closed — " +
          "cross-origin SSE/preflight responses will omit Access-Control-Allow-Origin. " +
          "Set FRONTEND_ORIGIN to the frontend origin(s) for this environment.",
      );
    }
    return "";
  }

  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  // `allowed` is non-empty here (guarded above); pin to the first entry.
  return allowed[0] ?? "";
}

/**
 * CORS headers for an SSE stream response / its preflight.
 *
 * When `origin` is empty (fail-closed: no allowlist configured) the
 * `Access-Control-Allow-Origin` header is OMITTED so the browser denies the
 * cross-origin read. The non-origin headers are still emitted.
 */
export function corsHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, last-event-id",
    vary: "Origin",
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

/** Re-wrap an upstream Response, merging in CORS headers (no mutation). */
export function withCors(res: Response, origin: string): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** 204 preflight response for an SSE event route. */
export function corsPreflight(origin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
