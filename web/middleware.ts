import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// NOTE: Next 16 renamed Middleware → Proxy, BUT `proxy.ts` runs on the Node.js
// runtime only (not configurable), which the OpenNext Cloudflare adapter does
// not support. The upgrade guide says to KEEP using the `middleware` convention
// for the Edge runtime — so this stays as middleware.ts until OpenNext ships
// edge-proxy support. It's edge-safe: it only reads a cookie and redirects.
//
// This is an OPTIMISTIC gate only. Real enforcement is the backend Worker's
// requireAuth middleware. See docs/superpowers/specs/2026-06-01-cloudflare-email-auth.md.

const PUBLIC_PATHS = ["/login", "/signup", "/verify"];

// Mirror of SUPABASE_COOKIE_NAME in lib/supabase-client.ts. Duplicated here on
// purpose: that module is a "use client" file that pulls in @supabase/supabase-js,
// which must not be bundled into the edge middleware. Keep the two in sync.
const SUPABASE_COOKIE_NAME = "bowtie-sb-auth";

// True when the build is configured for Supabase auth. NEXT_PUBLIC_* vars are
// inlined at build time, so this is a static check (no runtime toggle).
function usesSupabaseAuth(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_PROVIDER === "supabase";
}

// Optimistic presence check only — does a session cookie exist? Validity is
// enforced by the backend 401 (and the api.ts refresh-or-/login path).
function hasSessionCookie(request: NextRequest): boolean {
  if (usesSupabaseAuth()) {
    return Boolean(request.cookies.get(SUPABASE_COOKIE_NAME)?.value);
  }
  return Boolean(getSessionCookie(request));
}

export function middleware(request: NextRequest): NextResponse {
  // Local dev points the web app at the Python backend (no auth routes).
  if (process.env.AUTH_DISABLED === "true") return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (!hasSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Gate page navigations only. Exclude Next internals and ALL /api/* (data
  // calls are enforced by the backend 401, not redirected to login HTML).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"],
};
