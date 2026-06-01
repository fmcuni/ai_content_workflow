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

export function middleware(request: NextRequest): NextResponse {
  // Local dev points the web app at the Python backend (no auth routes).
  if (process.env.AUTH_DISABLED === "true") return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (!getSessionCookie(request)) {
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
