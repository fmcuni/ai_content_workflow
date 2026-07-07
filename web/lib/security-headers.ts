// ---------------------------------------------------------------------------
// Shared security headers (CSP + hardening) for the web surface.
//
// Single source of truth consumed in two places:
//   - next.config.mjs `headers()` — blanket `/(.*)` coverage for every page,
//     asset, and `_next/*` response the OpenNext Worker serves. This is the
//     primary mechanism and is OpenNext-compatible (OpenNext honours the
//     `headers()` config).
//   - middleware.ts — re-applied on the login-redirect responses the
//     middleware emits before a route is reached, so those short-circuit
//     responses carry the same headers.
//
// CSP NOTE — `script-src 'unsafe-inline'` (documented tradeoff):
// Next.js App Router injects inline <script> tags (RSC streaming payload +
// hydration bootstrap). A bare `script-src 'self'` breaks hydration. The
// strictly-correct fix is a per-request nonce, but in Next 16 that lives in
// `proxy.ts` (Node runtime), which the OpenNext Cloudflare adapter does NOT
// support — this app deliberately stays on edge `middleware.ts` (see its
// header comment). Nonce-CSP also forces every page into dynamic rendering
// (no static/ISR/CDN cache). So we use the Next-documented "Without Nonces"
// fallback: `script-src 'self' 'unsafe-inline'`. We NEVER use `'unsafe-eval'`
// — nothing in the production bundle needs it (React/Next only use eval in dev).
// `style-src 'unsafe-inline'` is required by Tailwind 4 / shadcn inline styles
// and is acceptable for styles.
// ---------------------------------------------------------------------------

/**
 * The Content-Security-Policy value, shared with the Workers backend
 * (deploy/cloudflare-workers/src/http/security-headers.ts) — keep the two in
 * sync. `connect-src` covers same-origin REST plus the cross-origin SSE/REST
 * (`https://*.franco-ma.workers.dev`), the collab WebSocket
 * (`wss://*.franco-ma.workers.dev`), and the Supabase Auth (GoTrue) endpoint
 * (`https://*.supabase.co`).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  // The `fmc.workers.dev` account was deprecated 2026-07-07 and removed here.
  // Add the Bowtie Enterprise Account's subdomain when prod migrates there —
  // derive from NEXT_PUBLIC_API_BASE instead if that's simpler at that point.
  "connect-src 'self' https://*.supabase.co https://*.franco-ma.workers.dev wss://*.franco-ma.workers.dev",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/** The full security-header set applied to every web response. */
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Internal tool — never index, follow, cache, or snippet any response.
  // Paired with app/robots.txt (disallow all) and the crawler-UA block in
  // middleware.ts. Mirrors the backend's security-headers.ts entry.
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
];

/** Apply the security headers to a mutable `Headers` instance (in place). */
export function applySecurityHeaders(headers: Headers): void {
  for (const { key, value } of SECURITY_HEADERS) {
    headers.set(key, value);
  }
}
