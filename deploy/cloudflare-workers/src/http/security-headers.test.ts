import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  applySecurityHeaders,
  CONTENT_SECURITY_POLICY,
  isWebSocketUpgrade,
  SECURITY_HEADERS,
} from "./security-headers";

// Mirror the exact middleware wired in src/index.ts so the test exercises the
// real ordering/behaviour without booting the full app (Hyperdrive, Workflows,
// Durable Objects, auth) — same hermetic strategy as step_config.test.ts.
function makeApp(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    if (c.res && !isWebSocketUpgrade(c.res)) {
      applySecurityHeaders(c.res.headers);
    }
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  // Simulate an SSE stream response (the /runs/:id/events shape).
  app.get("/sse", () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    });
  });
  // Simulate a WebSocket upgrade (the /runs/:id/doc handshake). In workerd an
  // upgrade Response carries a `webSocket` handle (and status 101); node's
  // undici forbids constructing status 101, so we model the handshake via the
  // `webSocket` property — which is exactly what `isWebSocketUpgrade` keys on.
  app.get("/doc", () => {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, "webSocket", { value: {}, configurable: true });
    return res;
  });
  return app;
}

const REQUIRED_HEADERS = [
  ["content-security-policy", CONTENT_SECURITY_POLICY],
  ["x-frame-options", "DENY"],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["x-robots-tag", "noindex, nofollow, noarchive, nosnippet"],
] as const;

describe("security-headers constant", () => {
  it("exports all five required headers", () => {
    const keys = SECURITY_HEADERS.map(([k]) => k);
    expect(keys).toEqual([
      "Content-Security-Policy",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Robots-Tag",
    ]);
  });

  it("CSP defaults to self, forbids unsafe-eval, and allows the SSE/WS + supabase origins", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(CONTENT_SECURITY_POLICY).toContain("https://*.supabase.co");
    expect(CONTENT_SECURITY_POLICY).toContain("https://*.fmc.workers.dev");
    expect(CONTENT_SECURITY_POLICY).toContain("wss://*.fmc.workers.dev");
    expect(CONTENT_SECURITY_POLICY).toContain("https://*.franco-ma.workers.dev");
    expect(CONTENT_SECURITY_POLICY).toContain("wss://*.franco-ma.workers.dev");
  });

  it("isWebSocketUpgrade detects an upgrade by webSocket handle or 101 status", () => {
    // workerd attaches a `webSocket` handle to the upgrade response.
    const withHandle = new Response("ok", { status: 200 });
    Object.defineProperty(withHandle, "webSocket", { value: {}, configurable: true });
    expect(isWebSocketUpgrade(withHandle)).toBe(true);
    // 101-status detection (cannot construct a real 101 in node undici, so
    // stub the shape the guard reads).
    expect(isWebSocketUpgrade({ status: 101, webSocket: null } as unknown as Response)).toBe(true);
    expect(isWebSocketUpgrade(new Response("ok", { status: 200 }))).toBe(false);
  });
});

describe("security-headers middleware", () => {
  it("stamps all five headers on a normal JSON route", async () => {
    const res = await makeApp().request("/health");
    expect(res.status).toBe(200);
    for (const [key, value] of REQUIRED_HEADERS) {
      expect(res.headers.get(key)).toBe(value);
    }
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("does NOT break the SSE response: keeps content-type + body + CORS, adds headers", async () => {
    const res = await makeApp().request("/sse");
    expect(res.status).toBe(200);
    // Stream is intact.
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    await expect(res.text()).resolves.toContain("data: hi");
    // Security headers were still applied.
    for (const [key, value] of REQUIRED_HEADERS) {
      expect(res.headers.get(key)).toBe(value);
    }
  });

  it("does NOT stamp CSP on a WebSocket-upgrade response", async () => {
    const res = await makeApp().request("/doc");
    // The upgrade response is skipped — no CSP stamped on it, handle preserved.
    expect((res as { webSocket?: unknown }).webSocket).toBeDefined();
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});
