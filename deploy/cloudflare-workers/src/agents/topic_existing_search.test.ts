import { describe, expect, it, beforeEach } from "vitest";
import type { Sql } from "postgres";

import {
  MAX_CANDIDATES,
  MAX_RESOLVE_ATTEMPTS,
  runExistingArticleSearch,
  type UrlResolveFn,
} from "./topic_existing_search";
import type { ResolvedUrl } from "./url_resolver";
import { FakeGeminiClient } from "../gemini/fake";
import { invalidate } from "../prompts/store";

const SEARCH_BODY = "你是 topic_existing_search agent。\n";

function makeFakeSql(): Sql {
  const tag = (strings: TemplateStringsArray): unknown => {
    const text = strings.join("?");
    if (text.includes("FROM content_tool.prompt_templates")) {
      return Promise.resolve([
        {
          template_id: "topic_existing_search",
          category: "agent",
          filename: "topic_existing_search.md",
          body: SEARCH_BODY,
          sha256: "y",
          bytes: SEARCH_BODY.length,
          updated_at: "2026-06-02T00:00:00Z",
          updated_by: null,
        },
      ]);
    }
    return Promise.resolve([]);
  };
  return tag as unknown as Sql;
}

function chunk(uri: string, title?: string): Record<string, unknown> {
  return { web: { uri, title } };
}

function resolver(map: Record<string, ResolvedUrl>): UrlResolveFn {
  return async (uri) =>
    map[uri] ?? { vertexUri: uri, finalUrl: null, domain: null, error: "unresolved" };
}

function bowtie(uri: string, url: string): ResolvedUrl {
  return { vertexUri: uri, finalUrl: url, domain: "bowtie.com.hk", error: null };
}

function gemini(grounding: Record<string, unknown>[]): FakeGeminiClient {
  return new FakeGeminiClient({}, { topic_existing_search: grounding });
}

describe("runExistingArticleSearch", () => {
  beforeEach(() => {
    invalidate();
  });

  it("returns resolved bowtie articles with titles, using googleSearch", async () => {
    const g = gemini([chunk("v1", "自願醫保比較"), chunk("v2", "退保")]);
    const resolve = resolver({
      v1: bowtie("v1", "https://www.bowtie.com.hk/blog/foo"),
      v2: bowtie("v2", "https://www.bowtie.com.hk/blog/bar"),
    });

    const { articles, diagnostics } = await runExistingArticleSearch(makeFakeSql(), g, resolve, {
      topic: "t",
      keywords: ["k"],
    });

    expect(articles.map((a) => a.url)).toEqual([
      "https://www.bowtie.com.hk/blog/foo",
      "https://www.bowtie.com.hk/blog/bar",
    ]);
    expect(articles[0]?.title).toBe("自願醫保比較");
    expect(g.calls[0]?.tools).toEqual(["googleSearch"]);
    expect(g.calls[0]?.userPrompt).toContain("site:bowtie.com.hk/blog");
    // Non-empty first pass → no retry, clean diagnostics.
    expect(g.calls).toHaveLength(1);
    expect(diagnostics).toMatchObject({
      grounding_chunks: 2,
      bowtie_hits: 2,
      resolve_failures: 0,
      filtered_out: 0,
      grounding_empty: false,
      second_pass: false,
    });
  });

  it("filters non-bowtie and counts unresolved chunks as resolve failures", async () => {
    const g = gemini([chunk("v1"), chunk("bad"), chunk("nores")]);
    const resolve = resolver({
      v1: bowtie("v1", "https://www.bowtie.com.hk/blog/foo"),
      bad: { vertexUri: "bad", finalUrl: "https://example.com/x", domain: "example.com", error: null },
    });

    const { articles, diagnostics } = await runExistingArticleSearch(makeFakeSql(), g, resolve, {
      topic: "t",
      keywords: [],
    });

    expect(articles.map((a) => a.url)).toEqual(["https://www.bowtie.com.hk/blog/foo"]);
    expect(diagnostics.filtered_out).toBe(1); // example.com resolved but not bowtie
    expect(diagnostics.resolve_failures).toBe(1); // "nores" never resolved
  });

  it("dedupes by URL ignoring trailing slash", async () => {
    const g = gemini([chunk("v1"), chunk("v2")]);
    const resolve = resolver({
      v1: bowtie("v1", "https://www.bowtie.com.hk/blog/foo"),
      v2: bowtie("v2", "https://www.bowtie.com.hk/blog/foo/"),
    });

    const { articles } = await runExistingArticleSearch(makeFakeSql(), g, resolve, {
      topic: "t",
      keywords: [],
    });

    expect(articles).toHaveLength(1);
  });

  it("caps at MAX_CANDIDATES", async () => {
    const n = MAX_CANDIDATES + 3;
    const chunks = Array.from({ length: n }, (_, i) => chunk(`v${i}`));
    const map: Record<string, ResolvedUrl> = {};
    for (let i = 0; i < n; i++) {
      map[`v${i}`] = bowtie(`v${i}`, `https://www.bowtie.com.hk/blog/p${i}`);
    }

    const { articles } = await runExistingArticleSearch(makeFakeSql(), gemini(chunks), resolver(map), {
      topic: "t",
      keywords: [],
    });

    expect(articles).toHaveLength(MAX_CANDIDATES);
  });

  it("caps resolve attempts per pass and retries once on empty", async () => {
    // Many non-bowtie chunks; an unbounded loop would HEAD them all and exhaust
    // the Workers per-invocation subrequest budget. Empty result triggers ONE
    // retry, so total resolves are bounded at 2 * MAX_RESOLVE_ATTEMPTS.
    const n = MAX_RESOLVE_ATTEMPTS + 10;
    const chunks = Array.from({ length: n }, (_, i) => chunk(`v${i}`));
    let calls = 0;
    const resolve: UrlResolveFn = async (uri) => {
      calls += 1;
      return { vertexUri: uri, finalUrl: "https://example.com/x", domain: "example.com", error: null };
    };

    const { articles, diagnostics } = await runExistingArticleSearch(makeFakeSql(), gemini(chunks), resolve, {
      topic: "t",
      keywords: [],
    });

    expect(articles).toEqual([]);
    expect(calls).toBe(MAX_RESOLVE_ATTEMPTS * 2);
    expect(diagnostics.attempt_cap_hit).toBe(true);
    expect(diagnostics.second_pass).toBe(true);
    expect(diagnostics.filtered_out).toBe(MAX_RESOLVE_ATTEMPTS);
  });

  it("returns an empty list (and retries) when there are no grounding chunks", async () => {
    const g = gemini([]);
    const { articles, diagnostics } = await runExistingArticleSearch(makeFakeSql(), g, resolver({}), {
      topic: "t",
      keywords: [],
    });
    expect(articles).toEqual([]);
    expect(g.calls).toHaveLength(2); // first pass empty → one retry
    expect(diagnostics.grounding_empty).toBe(true);
    expect(diagnostics.second_pass).toBe(true);
  });

  it("recovers via the retry when the first pass's resolves fail transiently", async () => {
    // Simulate a transient resolve failure: each vertex URI fails the first time
    // it is seen (first pass) and succeeds the second time (retry pass).
    const g = gemini([chunk("v1", "手足口病")]);
    const seen = new Set<string>();
    const resolve: UrlResolveFn = async (uri) => {
      if (!seen.has(uri)) {
        seen.add(uri);
        return { vertexUri: uri, finalUrl: null, domain: null, error: "Too many subrequests" };
      }
      return bowtie(uri, "https://www.bowtie.com.hk/blog/hfmd");
    };

    const { articles, diagnostics } = await runExistingArticleSearch(makeFakeSql(), g, resolve, {
      topic: "兒童夏日手足口病",
      keywords: [],
    });

    expect(articles.map((a) => a.url)).toEqual(["https://www.bowtie.com.hk/blog/hfmd"]);
    expect(diagnostics.second_pass).toBe(true);
    expect(diagnostics.bowtie_hits).toBe(1);
    expect(g.calls).toHaveLength(2);
  });
});
