/**
 * Open-redirect guard for `?redirect=` query params.
 *
 * Attacker-controlled redirect targets are a phishing / token-leakage vector:
 * `?redirect=https://evil.com` would bounce an authenticated user off-origin.
 * This helper accepts only a *same-origin relative* path and rejects anything
 * else (absolute cross-origin URLs, protocol-relative `//evil.com`,
 * `javascript:` and other schemes), falling back to a known-safe path.
 *
 * The returned value is always a relative path (pathname + search + hash) — the
 * origin is stripped even for valid same-origin absolute inputs — so it is safe
 * to hand directly to `router.push` / `router.replace`.
 */

const DEFAULT_FALLBACK = "/";

/**
 * SSR-safe path check: with no `window`, we cannot resolve relative URLs
 * against an origin, so we accept only single-leading-slash relative paths and
 * reject any value carrying a scheme, a protocol-relative `//` prefix, or a
 * backslash (browsers normalize `\` → `/`, so `/\evil.com` can be read as
 * `//evil.com` — treat any backslash as hostile).
 */
function isSafeRelativePath(value: string): boolean {
  return (
    value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
  );
}

export function safeRedirect(
  candidate: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (!candidate) return fallback;

  // SSR / non-browser: no origin to resolve against — only trust a bare
  // leading-slash relative path.
  if (typeof window === "undefined") {
    return isSafeRelativePath(candidate) ? candidate : fallback;
  }

  const origin = window.location.origin;

  try {
    const resolved = new URL(candidate, origin);
    // Cross-origin (absolute, protocol-relative, or a different host/scheme)
    // resolves to a different origin → reject.
    if (resolved.origin !== origin) return fallback;
    // Only ever return a same-origin relative path; strip the origin.
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    // Unparseable input — reject.
    return fallback;
  }
}
