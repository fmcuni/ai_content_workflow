import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { applySecurityHeaders } from "./lib/security-headers";

// NOTE: Next 16 renamed Middleware → Proxy, BUT `proxy.ts` runs on the Node.js
// runtime only (not configurable), which the OpenNext Cloudflare adapter does
// not support. The upgrade guide says to KEEP using the `middleware` convention
// for the Edge runtime — so this stays as middleware.ts until OpenNext ships
// edge-proxy support. It's edge-safe: it only reads a cookie and redirects.
//
// This is an OPTIMISTIC gate only. Real enforcement is the backend Worker's
// requireAuth middleware. See docs/superpowers/specs/2026-06-01-cloudflare-email-auth.md.

const PUBLIC_PATHS = ["/login", "/signup", "/verify"];

// Known crawler / scanner User-Agent substrings (lowercase). Internal tool on
// a public workers.dev URL — known bots get a flat 403 before any page is
// served. Conservative by design: never add generic words ("headless" would
// break the Playwright e2e + claude-debug harnesses). KEEP IN SYNC with
// deploy/cloudflare-workers/src/http/bot-guard.ts KNOWN_CRAWLER_UA_SNIPPETS.
const KNOWN_CRAWLER_UA_SNIPPETS = [
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

function isKnownCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return KNOWN_CRAWLER_UA_SNIPPETS.some((snippet) => ua.includes(snippet));
}

// Mirror of SUPABASE_COOKIE_NAME in lib/supabase-client.ts. Duplicated here on
// purpose: that module is a "use client" file that pulls in @supabase/supabase-js,
// which must not be bundled into the edge middleware. Keep the two in sync.
const SUPABASE_COOKIE_NAME = "bowtie-sb-auth";

// Optimistic presence check only — does a Supabase session cookie exist?
// Validity is enforced by the backend 401 (and the api.ts refresh-or-/login
// path).
//
// The Supabase session is chunked across `${name}.0`, `${name}.1`, … (a full
// session exceeds the ~4096-byte single-cookie limit — see lib/supabase-client.ts),
// so the first chunk `${name}.0` is the presence signal. The bare `${name}` is
// also accepted for any legacy pre-chunking cookie still in a browser.
function hasSessionCookie(request: NextRequest): boolean {
  return Boolean(
    request.cookies.get(`${SUPABASE_COOKIE_NAME}.0`)?.value ||
      request.cookies.get(SUPABASE_COOKIE_NAME)?.value,
  );
}

// Stamp the shared security headers (CSP + hardening) onto every response the
// middleware returns. next.config `headers()` is the primary mechanism (covers
// pages + assets); this ensures the login-redirect responses — emitted here
// before any route is reached — carry the same headers. Single source of truth:
// lib/security-headers.ts.
function withSecurityHeaders(response: NextResponse): NextResponse {
  applySecurityHeaders(response.headers);
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  // Known crawlers/scanners never get a page — not even /login. robots.txt is
  // excluded from the matcher below, so bots can still read the disallow rule.
  if (isKnownCrawler(request.headers.get("user-agent"))) {
    return withSecurityHeaders(new NextResponse("Forbidden", { status: 403 }));
  }

  // Local dev points the web app at the Python backend (no auth routes).
  if (process.env.AUTH_DISABLED === "true") return withSecurityHeaders(NextResponse.next());

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return withSecurityHeaders(NextResponse.next());
  }

  if (!hasSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return withSecurityHeaders(NextResponse.redirect(url));
  }
  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  // Gate page navigations only. Exclude Next internals, ALL /api/* (data
  // calls are enforced by the backend 401, not redirected to login HTML),
  // and robots.txt (must stay publicly fetchable so crawlers see the
  // disallow-all rule instead of a login redirect).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|api).*)"],
};
