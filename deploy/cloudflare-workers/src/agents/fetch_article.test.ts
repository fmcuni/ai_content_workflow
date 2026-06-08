import { describe, expect, it, vi } from "vitest";

import { runFetchArticle } from "./fetch_article";
import type { FetchArticleInput } from "./fetch_article";
import { WordPressClient } from "../wordpress/client";
import type { FetchedPost, WpCategory } from "../wordpress/types";
import type { Env } from "../index";

// ---------------------------------------------------------------------------
// Fixtures / fakes
// ---------------------------------------------------------------------------

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const ARTICLE_URL = "https://www.bowtie.com.hk/blog/post/sample-slug";

const SAMPLE_POST: FetchedPost = {
  id: 42,
  slug: "sample-slug",
  link: "https://www.bowtie.com.hk/blog/post/sample-slug",
  title: "Sample",
  contentHtml: "<h1>Heading</h1><p>Body <strong>bold</strong></p>",
  modifiedGmt: "2026-05-31T00:00:00",
  status: "publish",
  author: 7,
  categories: [3, 9],
};

const CATEGORIES: Record<number, WpCategory> = {
  3: { id: 3, name: "保險", slug: "insurance" },
  9: { id: 9, name: "健康", slug: "health" },
};

// Minimal Env — WordPressClient is injected, so WP_* are unused here.
const ENV = {} as Env;

/**
 * Build a fake `sql` tagged-template that records INSERTs and replays a
 * pre-seeded existing row (or none). Each call inspects the first SQL fragment
 * to decide SELECT vs INSERT.
 */
function makeFakeSql(existingRow: Record<string, unknown> | null) {
  const inserts: Array<unknown[]> = [];

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("SELECT")) {
      return Promise.resolve(existingRow === null ? [] : [existingRow]);
    }
    inserts.push(values);
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof runFetchArticle>[0];

  // toJsonb calls sql.json(value) — return the raw value so we can assert on it.
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  return { sql, inserts };
}

function makeWpClient(post: FetchedPost | null): WordPressClient {
  const client = Object.create(WordPressClient.prototype) as WordPressClient;
  vi.spyOn(client, "fetchPostByUrl").mockResolvedValue(post);
  vi.spyOn(client, "getCategory").mockImplementation((id: number) =>
    Promise.resolve(CATEGORIES[id] ?? null),
  );
  return client;
}

function baseInput(client: WordPressClient): FetchArticleInput {
  return { runId: RUN_ID, articleUrl: ARTICLE_URL, wpClient: client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runFetchArticle", () => {
  it("inserts a row and returns the fetched result on a fresh run", async () => {
    // Arrange
    const { sql, inserts } = makeFakeSql(null);
    const client = makeWpClient(SAMPLE_POST);

    // Act
    const result = await runFetchArticle(sql, ENV, baseInput(client));

    // Assert — result shape mirrors the WP post + hydrated categories
    expect(result.wpPostId).toBe(42);
    expect(result.wpCategories).toEqual([CATEGORIES[3], CATEGORIES[9]]);
    expect(result.rawHtml).toBe(SAMPLE_POST.contentHtml);
    expect(result.markdown).toContain("# Heading");
    expect(result.markdown).toContain("**bold**");

    // Exactly one INSERT happened
    expect(inserts).toHaveLength(1);
    // wp_categories bound value (3rd value) is the native array, not a string
    const insertValues = inserts[0]!;
    expect(insertValues[2]).toEqual([CATEGORIES[3], CATEGORIES[9]]);
  });

  it("hydrates full category objects via getCategory", async () => {
    const { sql } = makeFakeSql(null);
    const client = makeWpClient(SAMPLE_POST);

    await runFetchArticle(sql, ENV, baseInput(client));

    expect(client.getCategory).toHaveBeenCalledWith(3);
    expect(client.getCategory).toHaveBeenCalledWith(9);
  });

  it("short-circuits and does not insert when a row already exists", async () => {
    // Arrange — a pre-seeded existing row (jsonb already parsed to native array)
    const { sql, inserts } = makeFakeSql({
      wp_post_id: 99,
      wp_categories: [CATEGORIES[3]],
      raw_html: "<p>cached</p>",
      markdown: "cached md",
    });
    const client = makeWpClient(SAMPLE_POST);

    // Act
    const result = await runFetchArticle(sql, ENV, baseInput(client));

    // Assert — returns stored values, no WP fetch, no insert
    expect(result.wpPostId).toBe(99);
    expect(result.wpCategories).toEqual([CATEGORIES[3]]);
    expect(result.rawHtml).toBe("<p>cached</p>");
    expect(result.markdown).toBe("cached md");
    expect(client.fetchPostByUrl).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("parses a legacy double-encoded jsonb string for an existing row", async () => {
    const { sql } = makeFakeSql({
      wp_post_id: 99,
      wp_categories: JSON.stringify([CATEGORIES[9]]),
      raw_html: "<p>cached</p>",
      markdown: "cached md",
    });
    const client = makeWpClient(SAMPLE_POST);

    const result = await runFetchArticle(sql, ENV, baseInput(client));

    expect(result.wpCategories).toEqual([CATEGORIES[9]]);
  });

  it("falls back to the live page (wp_post_id null) when the post can't be resolved", async () => {
    // Arrange — WP returns no post; inject a live-HTML fetcher.
    const { sql, inserts } = makeFakeSql(null);
    const client = makeWpClient(null);
    const fetchLiveHtml = vi
      .fn<(url: string) => Promise<string>>()
      .mockResolvedValue("<h1>Live</h1><p>External body</p>");

    // Act
    const result = await runFetchArticle(sql, ENV, {
      ...baseInput(client),
      fetchLiveHtml,
    });

    // Assert — external source, no CMS post id, run is NOT blocked
    expect(result.source).toBe("live");
    expect(result.wpPostId).toBeNull();
    expect(result.wpCategories).toEqual([]);
    expect(result.rawHtml).toContain("External body");
    expect(result.markdown).toContain("# Live");
    expect(fetchLiveHtml).toHaveBeenCalledWith(ARTICLE_URL);

    // One INSERT with a null wp_post_id (2nd bound value)
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBeNull();
  });

  it("degrades to empty markdown (still inserts) when the live fetch fails", async () => {
    const { sql, inserts } = makeFakeSql(null);
    const client = makeWpClient(null);
    const fetchLiveHtml = vi
      .fn<(url: string) => Promise<string>>()
      .mockResolvedValue("");

    const result = await runFetchArticle(sql, ENV, {
      ...baseInput(client),
      fetchLiveHtml,
    });

    expect(result.source).toBe("live");
    expect(result.wpPostId).toBeNull();
    expect(result.rawHtml).toBe("");
    expect(result.markdown).toBe("");
    expect(inserts).toHaveLength(1);
  });

  it("treats a CMS transport error as not-found and falls back", async () => {
    const { sql } = makeFakeSql(null);
    const client = Object.create(WordPressClient.prototype) as WordPressClient;
    vi.spyOn(client, "fetchPostByUrl").mockRejectedValue(new Error("transport_error: boom"));
    const fetchLiveHtml = vi
      .fn<(url: string) => Promise<string>>()
      .mockResolvedValue("<p>live</p>");

    const result = await runFetchArticle(sql, ENV, {
      runId: RUN_ID,
      articleUrl: ARTICLE_URL,
      wpClient: client,
      fetchLiveHtml,
    });

    expect(result.source).toBe("live");
    expect(result.wpPostId).toBeNull();
    expect(fetchLiveHtml).toHaveBeenCalledOnce();
  });
});
