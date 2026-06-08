import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";

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
