import type { Sql } from "postgres";
import { getCached, upsertCache } from "../db/url_cache";

// HEAD-request timeout (ms) — mirrors Python `UrlResolver(timeout=5.0)`.
const RESOLVE_TIMEOUT_MS = 5000;

// Error messages are persisted to the cache + citations; keep them bounded so a
// noisy upstream error string can never blow up a row. ~200 chars per the brief.
const MAX_ERROR_LEN = 200;

export interface ResolvedUrl {
  vertexUri: string;
  finalUrl: string | null;
  domain: string | null;
  error: string | null;
}

// Second-level registry segments that appear in compound ccTLD suffixes the
// source policy cares about (e.g. .com.hk, .org.hk, .gov.hk). When the last
// label is a 2-letter ccTLD AND the second-to-last label is one of these, the
// public suffix is two labels deep, so the apex keeps three labels.
const SECOND_LEVEL_SEGMENTS: ReadonlySet<string> = new Set([
  "com",
  "org",
  "gov",
  "edu",
  "net",
  "idv",
]);

/**
 * Extract the registrable apex domain from a URL or bare hostname, lowercased.
 *
 * Mirrors the Python `tldextract`-based `_apex()` for every domain present in
 * the source policy:
 *  - Strip scheme/path/query/fragment/port → bare host.
 *  - <= 2 labels: return as-is (e.g. `who.int`, `reddit.com`).
 *  - 3+ labels: keep the last 2 labels normally, but keep 3 labels when the
 *    last label is a 2-letter ccTLD (e.g. `hk`) and the second-to-last label
 *    is a known registry segment (com/org/gov/edu/net/idv) → e.g.
 *    `www.ia.org.hk` → `ia.org.hk`, `www.hkma.gov.hk` → `hkma.gov.hk`.
 *
 * Returns null when no host can be parsed.
 */
export function apexDomain(raw: string): string | null {
  // Strip scheme.
  let host = raw.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, "");
  // Strip path/query/fragment, then port.
  host = (host.split(/[/?#]/)[0] ?? "").split(":")[0] ?? "";
  host = host.toLowerCase().trim();
  if (!host) return null;

  const labels = host.split(".").filter((label) => label.length > 0);
  if (labels.length === 0) return null;
  if (labels.length <= 2) return labels.join(".");

  const tld = labels[labels.length - 1] ?? "";
  const secondLabel = labels[labels.length - 2] ?? "";

  if (tld.length === 2 && SECOND_LEVEL_SEGMENTS.has(secondLabel)) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

function truncateError(message: string): string {
  return message.length > MAX_ERROR_LEN
    ? message.slice(0, MAX_ERROR_LEN)
    : message;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Resolve a Vertex grounding redirect URI to its final URL + apex domain.
 *
 * Cache-first: a fresh row short-circuits the network call. Otherwise issues a
 * HEAD with redirect following and a 5s timeout, derives the apex domain from
 * the post-redirect `response.url`, and writes the result back to the cache
 * (including the error case, so failures are not retried for the TTL window).
 */
export async function resolveUrl(
  sql: Sql,
  vertexUri: string,
): Promise<ResolvedUrl> {
  const cached = await getCached(sql, vertexUri);
  if (cached) {
    return {
      vertexUri,
      finalUrl: cached.final_url,
      domain: cached.domain,
      error: cached.error,
    };
  }

  let finalUrl: string | null = null;
  let domain: string | null = null;
  let error: string | null = null;

  try {
    const resp = await fetch(vertexUri, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    finalUrl = resp.url;
    domain = finalUrl ? apexDomain(finalUrl) : null;
  } catch (err: unknown) {
    finalUrl = null;
    domain = null;
    error = truncateError(errorMessage(err));
  }

  // Only cache *successful* resolutions. A transient failure — a HEAD timeout, a
  // network blip, or Cloudflare's "Too many subrequests by single Worker
  // invocation" per-invocation cap — must NOT be persisted: the 7-day TTL would
  // poison the URL so every later lookup returns a null domain, the existing
  // article is dropped from the candidate list, and topic-dedup wrongly answers
  // "no". Skipping the write lets the next encounter retry. Mirrors UrlResolver.
  if (error === null) {
    await upsertCache(sql, { vertexUri, finalUrl, domain, error });
  }
  return { vertexUri, finalUrl, domain, error };
}
