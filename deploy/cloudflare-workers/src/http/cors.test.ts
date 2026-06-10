import { describe, expect, it } from "vitest";

import { corsHeaders, corsPreflight, resolveCorsOrigin, withCors } from "./cors";

describe("resolveCorsOrigin", () => {
  it("fails closed (empty, no reflection) when no allowlist is configured", () => {
    // SECURITY: an unset FRONTEND_ORIGIN must NOT reflect an arbitrary origin.
    expect(resolveCorsOrigin("https://app.example.com", undefined)).toBe("");
  });

  it("fails closed when the allowlist is an empty/whitespace string", () => {
    expect(resolveCorsOrigin("https://app.example.com", "")).toBe("");
    expect(resolveCorsOrigin("https://app.example.com", "  ,  ")).toBe("");
  });

  it("never falls back to * when neither allowlist nor origin is present", () => {
    const resolved = resolveCorsOrigin(null, undefined);
    expect(resolved).not.toBe("*");
    expect(resolved).toBe("");
  });

  it("echoes the request origin when it is on the allowlist", () => {
    const allow = "https://a.example.com, https://b.example.com";
    expect(resolveCorsOrigin("https://b.example.com", allow)).toBe(
      "https://b.example.com",
    );
  });

  it("pins to the first allowlisted origin when the request origin is not allowed", () => {
    const allow = "https://a.example.com,https://b.example.com";
    expect(resolveCorsOrigin("https://evil.example.com", allow)).toBe(
      "https://a.example.com",
    );
  });

  it("pins to the first allowlisted origin when the request omits Origin", () => {
    expect(resolveCorsOrigin(null, "https://a.example.com")).toBe(
      "https://a.example.com",
    );
  });
});

describe("corsHeaders", () => {
  it("includes allow-origin, methods, headers, and Vary", () => {
    const h = corsHeaders("https://app.example.com");
    expect(h["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(h["access-control-allow-methods"]).toContain("GET");
    expect(h.vary).toBe("Origin");
  });

  it("omits Access-Control-Allow-Origin when origin is empty (fail closed)", () => {
    const h = corsHeaders("");
    expect(h["access-control-allow-origin"]).toBeUndefined();
    // Non-origin headers are still present.
    expect(h["access-control-allow-methods"]).toContain("GET");
    expect(h.vary).toBe("Origin");
  });
});

describe("CORS end-to-end fail-closed", () => {
  it("withCors does not set a permissive allow-origin when FRONTEND_ORIGIN is unset", () => {
    const origin = resolveCorsOrigin("https://anything.example.com", undefined);
    const wrapped = withCors(new Response("data: hi\n\n", { status: 200 }), origin);
    expect(wrapped.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("corsPreflight does not set a permissive allow-origin when FRONTEND_ORIGIN is unset", () => {
    const origin = resolveCorsOrigin("https://anything.example.com", undefined);
    const res = corsPreflight(origin);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("withCors sets the configured origin when FRONTEND_ORIGIN is set", () => {
    const origin = resolveCorsOrigin("https://app.example.com", "https://app.example.com");
    const wrapped = withCors(new Response("data: hi\n\n", { status: 200 }), origin);
    expect(wrapped.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });
});

describe("withCors", () => {
  it("merges CORS headers while preserving the upstream body, status, and headers", async () => {
    const upstream = new Response("data: hi\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });

    const wrapped = withCors(upstream, "https://app.example.com");

    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
    expect(wrapped.headers.get("cache-control")).toBe("no-cache");
    expect(wrapped.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(await wrapped.text()).toBe("data: hi\n\n");
  });
});

describe("corsPreflight", () => {
  it("returns 204 with CORS headers and no body", async () => {
    const res = corsPreflight("https://app.example.com");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(await res.text()).toBe("");
  });
});
