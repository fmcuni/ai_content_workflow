import { afterEach, describe, expect, it, vi } from "vitest";

import { api, buildLoginUrl } from "@/lib/api";

// A DELETE that succeeds returns 204 No Content with an EMPTY body (see the
// Workers route: `return c.body(null, 204)`). The shared `http` helper must not
// call `r.json()` on an empty body — doing so throws "Unexpected end of JSON
// input", which made the `remove` mutation error and left the comment on screen
// ("I cannot delete comments"). These tests pin the empty-body handling.

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response)),
  );
}

describe("api.deleteReviewThread — 204 No Content handling", () => {
  it("resolves when the server returns 204 with an empty body", async () => {
    // Response with a null body + 204 status: `.json()` on this throws, exactly
    // like the real DELETE response from the Worker.
    mockFetch(new Response(null, { status: 204 }));

    await expect(api.deleteReviewThread("run-1", "t-1")).resolves.toBeUndefined();
  });

  it("still throws on a real error status", async () => {
    mockFetch(new Response("nope", { status: 500 }));

    await expect(api.deleteReviewThread("run-1", "t-1")).rejects.toThrow(/500/);
  });
});

describe("buildLoginUrl — post-401 redirect target", () => {
  it("encodes the current path as the post-login redirect", () => {
    expect(buildLoginUrl("/runs/abc", "")).toBe("/login?redirect=%2Fruns%2Fabc");
  });

  it("preserves non-redirect query params on the current path", () => {
    expect(buildLoginUrl("/runs", "?tab=open")).toBe(
      `/login?redirect=${encodeURIComponent("/runs?tab=open")}`,
    );
  });

  it("strips an existing redirect param so it cannot nest", () => {
    // A 401 fired while already at /runs?redirect=/x must not re-wrap /x.
    expect(buildLoginUrl("/runs", "?redirect=%2Fx")).toBe("/login?redirect=%2Fruns");
  });

  it("returns null on auth routes so a 401 there can't reload the page (loop guard)", () => {
    // Masthead's useRole → /me fires on /login too; a 401 must NOT reload it.
    expect(buildLoginUrl("/login", "?redirect=%2Fruns")).toBeNull();
    expect(buildLoginUrl("/signup", "")).toBeNull();
    expect(buildLoginUrl("/verify", "?code=abc")).toBeNull();
  });
});
