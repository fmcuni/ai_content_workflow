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
// origin(s) in production. When unset (local dev) we reflect the request
// `Origin`, falling back to `*`. These streams carry no cookies/credentials and
// only public editorial content, so a reflected origin is safe.
// ---------------------------------------------------------------------------

/** Resolve the `Access-Control-Allow-Origin` value for a cross-origin request. */
export function resolveCorsOrigin(
  requestOrigin: string | null,
  allowlist: string | undefined,
): string {
  if (!allowlist) return requestOrigin ?? "*";
  const allowed = allowlist
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0] ?? "*";
}

/** CORS headers for an SSE stream response / its preflight. */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, last-event-id",
    vary: "Origin",
  };
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
