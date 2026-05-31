import { describe, expect, it } from "vitest";

import { corsHeaders, corsPreflight, resolveCorsOrigin, withCors } from "./cors";

describe("resolveCorsOrigin", () => {
  it("reflects the request origin when no allowlist is configured", () => {
    expect(resolveCorsOrigin("https://app.example.com", undefined)).toBe(
      "https://app.example.com",
    );
  });

  it("falls back to * when neither allowlist nor origin is present", () => {
    expect(resolveCorsOrigin(null, undefined)).toBe("*");
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
