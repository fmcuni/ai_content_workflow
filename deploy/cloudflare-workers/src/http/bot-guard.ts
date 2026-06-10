// ---------------------------------------------------------------------------
// Bot / crawler guard for the Workers backend.
//
// This is an internal tool on a public `*.workers.dev` URL. Defense layers:
//   1. `X-Robots-Tag: noindex, ...` on every response (security-headers.ts).
//   2. `/robots.txt` disallowing everything (served public, before auth).
//   3. This guard: known crawler / scanner User-Agents get a flat 403 before
//      any route logic runs, so the API surface is never enumerated by
//      well-behaved-but-curious bots or internet-wide scanners.
//
// Best-effort by design: a scraper that spoofs a browser UA sails through and
// is then stopped by `requireAuth` anyway. The list is deliberately
// CONSERVATIVE — substrings that only ever appear in crawler/scanner UAs.
// Never add generic words ("bot" alone would match nothing legit today but is
// too risky; "headless" would break the Playwright e2e + claude-debug
// harnesses). Kept in sync with web/middleware.ts KNOWN_CRAWLER_UA_SNIPPETS.
// ---------------------------------------------------------------------------

import type { Context, Next } from "hono";

/** Served at GET /robots.txt — disallow everything for every agent. */
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

/**
 * Lowercase UA substrings identifying search crawlers, AI scrapers, SEO
 * spiders, and internet-wide scanners. Substring match against the
 * lowercased User-Agent.
 */
export const KNOWN_CRAWLER_UA_SNIPPETS: readonly string[] = [
  // Search engines
  "googlebot",
  "bingbot",
  "slurp",
  "duckduckbot",
  "baiduspider",
  "yandexbot",
  "sogou",
  "exabot",
  "applebot",
  "petalbot",
  // Social preview fetchers
  "facebookexternalhit",
  "twitterbot",
  "linkedinbot",
  "telegrambot",
  "whatsapp",
  "discordbot",
  // AI / LLM scrapers
  "gptbot",
  "chatgpt-user",
  "oai-searchbot",
  "ccbot",
  "claudebot",
  "claude-web",
  "anthropic-ai",
  "perplexitybot",
  "bytespider",
  "amazonbot",
  "meta-externalagent",
  "google-extended",
  "cohere-ai",
  "diffbot",
  // SEO / archive spiders
  "semrushbot",
  "ahrefsbot",
  "mj12bot",
  "dotbot",
  "blexbot",
  "dataforseobot",
  "serpstatbot",
  "screaming frog",
  "ia_archiver",
  // Internet-wide scanners / recon
  "censysinspect",
  "censys",
  "shodan",
  "zgrab",
  "masscan",
  "nuclei",
  "nmap scripting engine",
  "expanse",
  "internetmeasurement",
  "paloaltonetworks",
];

/** True when the User-Agent identifies a known crawler or scanner. */
export function isKnownCrawler(userAgent: string | undefined | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return KNOWN_CRAWLER_UA_SNIPPETS.some((snippet) => ua.includes(snippet));
}

/**
 * Hono middleware: 403 any known crawler/scanner UA. Register AFTER the
 * /robots.txt route (crawlers must be able to read the disallow) and BEFORE
 * the auth/REST surface.
 */
export async function blockKnownCrawlers(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  if (isKnownCrawler(c.req.header("user-agent"))) {
    return c.text("Forbidden", 403);
  }
  await next();
  return undefined;
}
