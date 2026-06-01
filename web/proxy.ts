import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next 16 renamed Middleware → Proxy (same functionality). This is an
// OPTIMISTIC gate only: it redirects page navigations with no session cookie to
// /login. Real enforcement is the backend Worker's requireAuth middleware — the
// backend is publicly reachable, so the cookie check here is convenience, not
// security. See docs/superpowers/specs/2026-06-01-cloudflare-email-auth.md.

const PUBLIC_PATHS = ["/login", "/signup", "/verify"];

export function proxy(request: NextRequest): NextResponse {
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
