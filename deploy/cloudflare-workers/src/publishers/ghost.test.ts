import { describe, it, expect } from "vitest";
import {
  GhostPublisher,
  GhostConflictError,
  ghostAdminBase,
  ghostAdminToken,
  buildGhostCreds,
} from "./ghost";

// A 32-char hex "secret" + a 24-char hex "id" — same shape as a real Ghost
// Admin API key. Not a real credential.
const ID = "0123456789abcdef01234567";
const SECRET = "00112233445566778899aabbccddeeff";
const ADMIN_KEY = `${ID}:${SECRET}`;
const CREDS = { apiUrl: "https://demo.ghost.io", adminKey: ADMIN_KEY };

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responder: (call: RecordedCall) => { status: number; body: unknown }) {
  const calls: RecordedCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status, body } = responder(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

function b64urlToJson(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("ghostAdminBase", () => {
  it("appends the admin path to a bare site URL", () => {
    expect(ghostAdminBase("https://x.ghost.io/")).toBe("https://x.ghost.io/ghost/api/admin");
  });
  it("normalises a URL that already includes the api path", () => {
    expect(ghostAdminBase("https://x.ghost.io/ghost/api/content")).toBe(
      "https://x.ghost.io/ghost/api/admin",
    );
  });
  it("throws on an empty URL", () => {
    expect(() => ghostAdminBase("  ")).toThrow();
  });
});

describe("ghostAdminToken", () => {
  it("mints a verifiable HS256 JWT with kid, aud and a 5-minute expiry", async () => {
    const token = await ghostAdminToken(ADMIN_KEY, 1_000_000);
    const [h, p, sig] = token.split(".") as [string, string, string];
    const header = b64urlToJson(h);
    const payload = b64urlToJson(p);
    expect(header).toMatchObject({ alg: "HS256", typ: "JWT", kid: ID });
    expect(payload).toMatchObject({ iat: 1_000_000, exp: 1_000_300, aud: "/admin/" });
    // Signature verifies against the hex-decoded secret.
    const keyBytes = new Uint8Array(SECRET.match(/../g)!.map((b) => parseInt(b, 16)));
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = Uint8Array.from(
      atob(sig.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });

  it("rejects a key without a colon", async () => {
    await expect(ghostAdminToken("nocolonkey", 1)).rejects.toThrow(/id.*secret/i);
  });
});

describe("GhostPublisher.upsert", () => {
  const basePayload = {
    title: "Test",
    html: '<p>Body</p>\n<div class="editor__item editor__faq">\n  <div class="e-faq__wrap">x</div>\n</div>',
    slug: "test-slug",
    status: "publish",
    excerpt: "summary",
  };

  it("creates a draft via POST ?source=html, card-fences the FAQ, maps status, returns a string id", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 201,
      body: { posts: [{ id: "uuid-123", url: "https://demo.ghost.io/p/uuid-123/", slug: "test-slug", status: "published" }] },
    }));
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    const result = await pub.upsert({ ...basePayload, postId: null });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://demo.ghost.io/ghost/api/admin/posts/?source=html");
    expect(calls[0]!.headers["Authorization"]).toMatch(/^Ghost /);
    const sent = (calls[0]!.body as { posts: { html: string; status: string }[] }).posts[0]!;
    expect(sent.html).toContain("<!--kg-card-begin: html-->");
    expect(sent.status).toBe("published"); // "publish" → "published"
    expect(result).toEqual({
      id: "uuid-123",
      link: "https://demo.ghost.io/p/uuid-123/",
      status: "published",
      slug: "test-slug",
    });
  });

  it("maps a non-publish status to draft", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 201,
      body: { posts: [{ id: "u", url: "l", slug: "s", status: "draft" }] },
    }));
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    await pub.upsert({ ...basePayload, postId: null, status: "draft" });
    expect((calls[0]!.body as { posts: { status: string }[] }).posts[0]!.status).toBe("draft");
  });

  it("updates an existing post: GET for updated_at, then PUT with it", async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.method === "GET"
        ? { status: 200, body: { posts: [{ id: "uuid-9", updated_at: "2026-06-17T00:00:00.000Z" }] } }
        : { status: 200, body: { posts: [{ id: "uuid-9", url: "https://demo.ghost.io/p/uuid-9/", slug: "s", status: "published" }] } },
    );
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    const result = await pub.upsert({ ...basePayload, postId: "uuid-9" });

    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]!.url).toBe("https://demo.ghost.io/ghost/api/admin/posts/uuid-9/?source=html");
    expect((calls[1]!.body as { posts: { updated_at: string }[] }).posts[0]!.updated_at).toBe(
      "2026-06-17T00:00:00.000Z",
    );
    expect(result.id).toBe("uuid-9");
  });

  it("throws GhostConflictError on a 409 stale-update", async () => {
    const { impl } = fakeFetch((call) =>
      call.method === "GET"
        ? { status: 200, body: { posts: [{ id: "uuid-9", updated_at: "stale" }] } }
        : { status: 409, body: { errors: [{ message: "Saving failed! Someone else is editing." }] } },
    );
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    await expect(pub.upsert({ ...basePayload, postId: "uuid-9" })).rejects.toBeInstanceOf(
      GhostConflictError,
    );
  });

  it("throws a descriptive error when create fails (no slug → can't dedupe)", async () => {
    const { impl } = fakeFetch(() => ({ status: 422, body: { errors: [{ message: "bad" }] } }));
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    // slug:null → no read-back possible, so the create error propagates.
    await expect(
      pub.upsert({ ...basePayload, slug: null, postId: null }),
    ).rejects.toThrow(/Ghost create failed \(422\)/);
  });

  it("create dedupe: returns the existing post when the POST fails but the slug landed", async () => {
    // The POST is blocked (502) but Ghost actually created the post; the slug
    // read-back finds it, so create returns that post instead of duplicating.
    const { impl, calls } = fakeFetch((call) =>
      call.method === "POST"
        ? { status: 502, body: { errors: [{ message: "bad gateway" }] } }
        : {
            status: 200,
            body: {
              posts: [
                {
                  id: "landed-uuid",
                  url: "https://demo.ghost.io/p/landed-uuid/",
                  slug: "test-slug",
                  status: "published",
                },
              ],
            },
          },
    );
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    const result = await pub.upsert({ ...basePayload, postId: null });

    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(calls[1]!.url).toBe(
      "https://demo.ghost.io/ghost/api/admin/posts/slug/test-slug/?formats=html",
    );
    expect(result).toEqual({
      id: "landed-uuid",
      link: "https://demo.ghost.io/p/landed-uuid/",
      status: "published", // payload status "publish" → "published"
      slug: "test-slug",
    });
  });

  it("create dedupe: rethrows when the read-back finds no post with that slug", async () => {
    // POST fails AND the slug read-back 404s → the create never landed; rethrow.
    const { impl } = fakeFetch((call) =>
      call.method === "POST"
        ? { status: 502, body: { errors: [{ message: "bad gateway" }] } }
        : { status: 404, body: { errors: [{ message: "Resource not found" }] } },
    );
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    await expect(pub.upsert({ ...basePayload, postId: null })).rejects.toThrow(
      /Ghost create failed \(502\)/,
    );
  });
});

describe("GhostPublisher.fetchPostBySlug", () => {
  it("returns the mapped post on a 200", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        posts: [
          {
            id: "uuid-7",
            slug: "my-slug",
            url: "https://demo.ghost.io/my-slug/",
            title: "My Title",
            html: "<h1>Body</h1>",
          },
        ],
      },
    }));
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    const post = await pub.fetchPostBySlug("my-slug");

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      "https://demo.ghost.io/ghost/api/admin/posts/slug/my-slug/?formats=html",
    );
    expect(post).toEqual({
      id: "uuid-7",
      slug: "my-slug",
      url: "https://demo.ghost.io/my-slug/",
      title: "My Title",
      html: "<h1>Body</h1>",
    });
  });

  it("returns null on a 404", async () => {
    const { impl } = fakeFetch(() => ({
      status: 404,
      body: { errors: [{ message: "Resource not found" }] },
    }));
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    expect(await pub.fetchPostBySlug("missing")).toBeNull();
  });
});

describe("GhostPublisher metadata + reads", () => {
  it("maps the WordPress-parity metadata onto the Ghost post body", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 201,
      body: { posts: [{ id: "u", url: "l", slug: "s", status: "scheduled" }] },
    }));
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    await pub.upsert({
      postId: null,
      title: "T",
      html: "<p>x</p>",
      slug: "s",
      status: "future",
      excerpt: "e",
      authorIds: ["a1", "a2"],
      tags: ["Body Check", "香港"],
      featureImage: "https://img/x.jpg",
      metaTitle: "MT",
      metaDescription: "MD",
      codeInjectionHead: '<script type="application/ld+json">{"@type":"FAQPage"}</script>',
      publishedAt: "2026-07-01T00:00:00.000Z",
    });
    const sent = (calls[0]!.body as { posts: Record<string, unknown>[] }).posts[0]!;
    expect(sent.status).toBe("scheduled"); // "future" → "scheduled"
    expect(sent.authors).toEqual([{ id: "a1" }, { id: "a2" }]);
    expect(sent.tags).toEqual([{ name: "Body Check" }, { name: "香港" }]);
    expect(sent.feature_image).toBe("https://img/x.jpg");
    expect(sent.meta_title).toBe("MT");
    expect(sent.meta_description).toBe("MD");
    expect(sent.codeinjection_head).toBe(
      '<script type="application/ld+json">{"@type":"FAQPage"}</script>',
    );
    expect(sent.published_at).toBe("2026-07-01T00:00:00.000Z");
  });

  it("omits absent metadata fields (an update never blanks them)", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 201,
      body: { posts: [{ id: "u", url: "l", slug: "s", status: "draft" }] },
    }));
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    await pub.upsert({
      postId: null,
      title: "T",
      html: "<p>x</p>",
      slug: null,
      status: "draft",
      excerpt: null,
      // The production path no longer passes metaTitle (Ghost falls back to the
      // post title). Verify nothing is sent for it when not supplied.
      metaDescription: "MD",
    });
    const sent = (calls[0]!.body as { posts: Record<string, unknown>[] }).posts[0]!;
    expect(sent.authors).toBeUndefined();
    expect(sent.tags).toBeUndefined();
    expect(sent.feature_image).toBeUndefined();
    expect(sent.meta_title).toBeUndefined();
    expect(sent.meta_description).toBe("MD");
    expect(sent.codeinjection_head).toBeUndefined();
    expect(sent.published_at).toBeUndefined();
  });

  it("listAuthors maps staff users to {id,name,slug}", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { users: [{ id: "6a", name: "Bow", slug: "bow", email: "x@y.z" }] },
    }));
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    expect(await pub.listAuthors()).toEqual([{ id: "6a", name: "Bow", slug: "bow" }]);
    expect(calls[0]!.url).toBe("https://demo.ghost.io/ghost/api/admin/users/?limit=all");
  });

  it("listTags returns public tags only (drops internal #tags)", async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: {
        tags: [
          { name: "身體檢查", slug: "hc", visibility: "public" },
          { name: "#wp", slug: "hash-wp", visibility: "internal" },
        ],
      },
    }));
    const pub = new GhostPublisher(CREDS, { fetchImpl: impl, nowSeconds: () => 1 });
    expect(await pub.listTags()).toEqual([{ name: "身體檢查", slug: "hc" }]);
  });
});

describe("buildGhostCreds", () => {
  it("reads {ref}_API_URL and {ref}_ADMIN_API_KEY from env", () => {
    const env = { HCHK_GT_API_URL: "https://x.ghost.io", HCHK_GT_ADMIN_API_KEY: ADMIN_KEY };
    expect(buildGhostCreds(env, "HCHK_GT")).toEqual({ apiUrl: "https://x.ghost.io", adminKey: ADMIN_KEY });
  });
  it("throws when a required env var is missing", () => {
    expect(() => buildGhostCreds({ HCHK_GT_API_URL: "https://x.ghost.io" }, "HCHK_GT")).toThrow(
      /HCHK_GT_ADMIN_API_KEY/,
    );
  });
  it("throws when auth_ref is null", () => {
    expect(() => buildGhostCreds({}, null)).toThrow(/auth_ref/);
  });
});
