// ---------------------------------------------------------------------------
// Custom Worker entry — fast path in front of OpenNext's Next server handler.
//
// WHY: every app route is prerendered at build time (verified via
// .next/prerender-manifest.json — no dynamicRoutes), but every request was
// still entering OpenNext's full Next server handler (20-250ms of CPU on the
// Workers free plan's 10ms cap) even though most requests only need a static
// HTML file, a 403/404, or a proxy passthrough.
//
// This entry classifies the request with the pure, unit-tested logic in
// lib/worker-routing.ts and only delegates to the real Next handler
// (.open-next/worker.js, dynamically imported so it's never compiled/executed
// on the fast paths) when nothing else applies: RSC/client-nav requests,
// POSTs to pages, and unknown routes.
//
// Order matters and mirrors middleware.ts + next.config.mjs exactly — see
// lib/worker-routing.ts for the single source of truth on route mapping.
// ---------------------------------------------------------------------------

import { applySecurityHeaders } from "./lib/security-headers.ts";
import { classifyRequest } from "./lib/worker-routing.ts";
import { API_BASE, PRERENDERED } from "./.open-next/entry-config.mjs";

const PRERENDERED_ROUTES = new Set(PRERENDERED);

function withSecurityHeaders(response) {
  applySecurityHeaders(response.headers);
  return response;
}

function forbidden() {
  return withSecurityHeaders(new Response("Forbidden", { status: 403 }));
}

function staticMiss() {
  // ponytail: no security headers on a static-asset miss — it's not a
  // document response and next.config's headers() never covered asset 404s
  // either. Bump if a security review wants headers everywhere.
  return new Response("Not Found", { status: 404 });
}

function redirectToLogin(request, location) {
  const url = new URL(location, request.url);
  return withSecurityHeaders(new Response(null, { status: 307, headers: { location: url.toString() } }));
}

async function servePrerendered(request, env, route) {
  const assetUrl = new URL(route === "/" ? "/__prerender/index.html" : `/__prerender${route}.html`, request.url);
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
  const response = new Response(assetResponse.body, assetResponse);
  response.headers.set("content-type", "text/html; charset=utf-8");
  response.headers.set("cache-control", "private, no-cache");
  return withSecurityHeaders(response);
}

async function delegateToNext(request, env, ctx) {
  const mod = await import("./.open-next/worker.js");
  return mod.default.fetch(request, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const decision = classifyRequest({
      method: request.method,
      pathname: url.pathname,
      userAgent: request.headers.get("user-agent"),
      cookieHeader: request.headers.get("cookie"),
      isRscRequest: Boolean(request.headers.get("rsc")),
      prerenderedRoutes: PRERENDERED_ROUTES,
      apiBase: API_BASE,
      search: url.search,
    });

    switch (decision.type) {
      case "crawler-403":
        return forbidden();
      case "static-miss-404":
        return staticMiss();
      case "api-proxy": {
        // redirect: "manual" — a reverse proxy must pass 3xx through to the
        // browser, not follow it inside the Worker.
        //
        // Dispatched over the API service binding (Worker→Worker inside
        // Cloudflare) rather than a public fetch: edge policies on the API's
        // public hostname (Cloudflare Access / WARP) would block this
        // server-side hop, which carries no WARP identity. Falls back to a
        // public fetch only when the binding is absent (local `wrangler dev`
        // without the backend Worker running).
        const proxied = new Request(decision.target, request);
        const upstream = env.API ?? { fetch };
        return upstream.fetch(proxied, { redirect: "manual" });
      }
      case "redirect-login":
        return redirectToLogin(request, decision.location);
      case "prerender-hit":
        return servePrerendered(request, env, decision.route);
      case "delegate":
      default:
        return delegateToNext(request, env, ctx);
    }
  },
};
