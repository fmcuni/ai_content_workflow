import { afterEach, describe, expect, it, vi } from "vitest";

import { WordPressClient, WordPressConflictError, WordPressError } from "./client";
import type { Env } from "../index";
import type { PublishPayload } from "./types";

const ENV = {
  WP_BASE_URL: "https://wp.example.com",
  WP_USERNAME: "user",
  WP_APP_PASSWORD: "pass",
} as unknown as Env;

/** Zero-backoff, no-op-sleep client so retries never actually wait. */
function makeClient(): WordPressClient {
  return new WordPressClient(ENV, {
    maxAttempts: 3,
    backoffBaseMs: 0,
    sleep: async () => undefined,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A WordPress post-shaped JSON response. */
function postResponse(
  overrides: Partial<Record<string, unknown>> = {},
  status = 200,
): Response {
  return jsonResponse(
    {
      id: 123,
      link: "https://wp.example.com/?p=123",
      status: "publish",
      modified_gmt: "2026-06-02T00:00:00",
      slug: "my-slug",
      ...overrides,
    },
    status,
  );
}

/** Infra block: 2xx (or any status) with an HTML body and non-JSON content-type. */
function htmlBlockResponse(status = 200): Response {
  return new Response("<html><body>403 Forbidden</body></html>", {
    status,
    headers: { "content-type": "text/html", "x-cache": "Error from cloudfront" },
  });
}

/** A response that *claims* JSON but is truncated/unparseable. */
function truncatedJsonResponse(status = 200): Response {
  return new Response('{"id": 123, "link', {
    status,
    headers: { "content-type": "application/json" },
  });
}

function updatePayload(overrides: Partial<PublishPayload> = {}): PublishPayload {
  return {
    postId: 123,
    title: "T",
    content: "<p>c</p>",
    excerpt: null,
    status: "publish",
    slug: "my-slug",
    categories: [],
    tags: [],
    author: null,
    featuredMedia: null,
    meta: {},
    ifUnmodifiedSince: null,
    dateGmt: null,
    template: null,
    ...overrides,
  };
}

function createPayload(overrides: Partial<PublishPayload> = {}): PublishPayload {
  return updatePayload({ postId: null, ...overrides });
}

/**
 * Build a fetch mock that returns each supplied response (or throws Error) in
 * order. A Response body can only be read once, so each item is cloned before
 * being handed out — this keeps repeated/exhausted items reusable across retries.
 */
function sequencedFetch(...items: Array<Response | Error>): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => {
    const item = items[Math.min(i, items.length - 1)];
    i += 1;
    if (item === undefined) throw new Error("sequencedFetch: no responses configured");
    if (item instanceof Error) throw item;
    return item.clone();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upsert resilience — update (PUT) path", () => {
  it("case 1: update success unchanged → returns result, exactly one call", async () => {
    const fetchMock = sequencedFetch(postResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().upsert(updatePayload());

    expect(result.id).toBe(123);
    expect(result.slug).toBe("my-slug");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("case 2: 2xx HTML block then 200 JSON → retries PUT, succeeds, two calls", async () => {
    const fetchMock = sequencedFetch(htmlBlockResponse(200), postResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().upsert(updatePayload());

    expect(result.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("case 3: 200 application/json but truncated body then 200 JSON → retries, succeeds", async () => {
    const fetchMock = sequencedFetch(truncatedJsonResponse(200), postResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().upsert(updatePayload());

    expect(result.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("case 4: 5xx then 200 → retries, succeeds", async () => {
    const fetchMock = sequencedFetch(jsonResponse({ error: "boom" }, 503), postResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().upsert(updatePayload());

    expect(result.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("case 5: transport error then 200 → retries, succeeds", async () => {
    const fetchMock = sequencedFetch(new Error("ECONNRESET"), postResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().upsert(updatePayload());

    expect(result.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("case 6: persistent non-JSON for all attempts → WordPressError after maxAttempts calls", async () => {
    const fetchMock = sequencedFetch(htmlBlockResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient();
    await expect(client.upsert(updatePayload())).rejects.toBeInstanceOf(WordPressError);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // message includes status + content-type + x-cache for diagnosis
    try {
      vi.stubGlobal("fetch", sequencedFetch(htmlBlockResponse(200)));
      await makeClient().upsert(updatePayload());
    } catch (err) {
      expect(err).toBeInstanceOf(WordPressError);
      const msg = (err as Error).message;
      expect(msg).toContain("200");
      expect(msg).toContain("text/html");
      expect(msg).toContain("x-cache");
    }
  });

  it("case 7: 412 on update → WordPressConflictError, exactly one call (no retry)", async () => {
    const fetchMock = sequencedFetch(jsonResponse({ code: "rest_post_conflict" }, 412));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().upsert(updatePayload())).rejects.toBeInstanceOf(
      WordPressConflictError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("case 8: 4xx + JSON error body on update → WordPressError, one call (no retry)", async () => {
    const fetchMock = sequencedFetch(
      jsonResponse({ code: "rest_invalid_param", message: "bad slug" }, 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient();
    await expect(client.upsert(updatePayload())).rejects.toBeInstanceOf(WordPressError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("upsert resilience — create (POST) path + read-back gate", () => {
  it("case 9: create success unchanged → POST 201 + JSON returns result, one call", async () => {
    const fetchMock = sequencedFetch(postResponse({}, 201));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().upsert(createPayload());

    expect(result.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("case 10: infra block on POST, read-back FINDS the post → no second POST, returns found", async () => {
    // 1st call: POST → infra block. 2nd call: read-back GET → finds the post.
    const found = jsonResponse([
      {
        id: 999,
        link: "https://wp.example.com/found",
        status: "draft",
        slug: "my-slug",
        modified_gmt: "2026-06-02T01:00:00",
      },
    ]);
    const fetchMock = sequencedFetch(htmlBlockResponse(200), found);
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().upsert(createPayload());

    expect(result.id).toBe(999);
    expect(result.link).toBe("https://wp.example.com/found");
    expect(result.status).toBe("draft");
    // exactly two calls total: one POST + one read-back GET; NO second POST.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const postCalls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
  });

  it("case 11: infra block on POST, read-back NOT_FOUND → second POST issued, succeeds", async () => {
    // POST block → read-back empty array → retry POST succeeds.
    const fetchMock = sequencedFetch(
      htmlBlockResponse(200),
      jsonResponse([]),
      postResponse({}, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().upsert(createPayload());

    expect(result.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postCalls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(2);
  });

  it("case 12: infra block on POST, read-back itself blocked (UNKNOWN) → WordPressError, only one POST", async () => {
    // POST block → read-back also blocked (non-JSON) → cannot prove absence → throw, no retry.
    const fetchMock = sequencedFetch(htmlBlockResponse(200), htmlBlockResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient();
    await expect(client.upsert(createPayload())).rejects.toBeInstanceOf(WordPressError);

    const postCalls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
  });

  it("case 13: create with slug=null, infra block → WordPressError, no second POST, message states no slug", async () => {
    const fetchMock = sequencedFetch(htmlBlockResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient();
    try {
      await client.upsert(createPayload({ slug: null }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WordPressError);
      expect((err as Error).message.toLowerCase()).toContain("slug");
    }
    const postCalls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
  });

  it("case 15: read-back gate runs on the FINAL attempt → blocked-but-landed create is recovered", async () => {
    // maxAttempts=1 isolates the final attempt: POST is blocked, but the create
    // actually landed at WP, so the read-back must still fire and recover it as
    // success (no false failure → no operator-driven duplicate).
    const found = jsonResponse([
      {
        id: 999,
        link: "https://wp.example.com/found",
        status: "publish",
        slug: "my-slug",
        modified_gmt: "2026-06-02T01:00:00",
      },
    ]);
    const fetchMock = sequencedFetch(htmlBlockResponse(200), found);
    vi.stubGlobal("fetch", fetchMock);

    const client = new WordPressClient(ENV, {
      maxAttempts: 1,
      backoffBaseMs: 0,
      sleep: async () => undefined,
    });
    const result = await client.upsert(createPayload());

    expect(result.id).toBe(999);
    const postCalls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
  });
});

describe("findPostBySlug query shape", () => {
  it("case 14: requests status=any and the expected _fields", async () => {
    const fetchMock = sequencedFetch(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await makeClient().findPostBySlug("my-slug");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("slug=my-slug");
    expect(url).toContain("status=any");
    expect(decodeURIComponent(url)).toContain("_fields=id,link,status,slug,modified_gmt");
  });

  it("read-back: non-JSON response maps to unknown and does not throw", async () => {
    const fetchMock = sequencedFetch(htmlBlockResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().findPostBySlug("my-slug");
    expect(result.kind).toBe("unknown");
  });

  it("read-back: found post is returned", async () => {
    const fetchMock = sequencedFetch(
      jsonResponse([{ id: 5, link: "l", status: "draft", slug: "s", modified_gmt: "m" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().findPostBySlug("s");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.post.id).toBe(5);
    }
  });

  it("read-back: empty array maps to not_found", async () => {
    const fetchMock = sequencedFetch(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().findPostBySlug("s");
    expect(result.kind).toBe("not_found");
  });
});

describe("fetchPostByUrl slug encoding", () => {
  // Regression: a percent-encoded CJK slug (the zh Bowtie blog) must be decoded
  // ONCE so URLSearchParams encodes it a single time. The pre-fix code passed the
  // raw "%E7%B4%AB..." segment straight in, double-encoding it ("%25E7%25B4%25AB")
  // so WP matched nothing → refresh created a duplicate post (slug-2).
  it("case 15: decodes a CJK URL slug and queries WP single-encoded (not double)", async () => {
    const fetchMock = sequencedFetch(
      jsonResponse([
        {
          id: 110536,
          slug: "紫蘇油",
          link: "https://wp.example.com/blog/zh/營養貼士/紫蘇油/",
          title: { rendered: "紫蘇油" },
          content: { rendered: "<p>c</p>" },
          modified_gmt: "2026-06-02T00:00:00",
          status: "publish",
          author: 4,
          categories: [9],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const post = await makeClient().fetchPostByUrl(
      "https://wp.example.com/blog/zh/%E7%87%9F%E9%A4%8A%E8%B2%BC%E5%A3%AB/%E7%B4%AB%E8%98%87%E6%B2%B9/",
    );

    expect(post?.id).toBe(110536);
    const url = String(fetchMock.mock.calls[0]![0]);
    // Correctly single-encoded — never the double-encoded "%25..." that broke it.
    expect(url).toContain("slug=%E7%B4%AB%E8%98%87%E6%B2%B9");
    expect(url).not.toContain("%25");
    expect(decodeURIComponent(url)).toContain("slug=紫蘇油");
  });

  it("case 16: returns null for a slugless URL without throwing", async () => {
    const fetchMock = sequencedFetch(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const post = await makeClient().fetchPostByUrl("https://wp.example.com/");
    expect(post).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
