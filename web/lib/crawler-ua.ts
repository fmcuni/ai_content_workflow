// Known crawler / scanner User-Agent substrings (lowercase). Internal tool on
// a public workers.dev URL — known bots get a flat 403 before any page is
// served. Conservative by design: never add generic words ("headless" would
// break the Playwright e2e + claude-debug harnesses). KEEP IN SYNC with
// deploy/cloudflare-workers/src/http/bot-guard.ts KNOWN_CRAWLER_UA_SNIPPETS.
//
// Shared by middleware.ts (edge runtime) and worker-entry.mjs (raw Worker
// fast path) so the two can never drift. No next/server import here — this
// file must stay usable from a bare Worker entry that never loads Next.
export const KNOWN_CRAWLER_UA_SNIPPETS = [
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

export function isKnownCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return KNOWN_CRAWLER_UA_SNIPPETS.some((snippet) => ua.includes(snippet));
}
