import { describe, expect, it, beforeEach } from "vitest";
import type { Sql } from "postgres";

import {
  MAX_CANDIDATES,
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

    const out = await runExistingArticleSearch(makeFakeSql(), g, resolve, {
      topic: "t",
      keywords: ["k"],
    });

    expect(out.map((a) => a.url)).toEqual([
      "https://www.bowtie.com.hk/blog/foo",
      "https://www.bowtie.com.hk/blog/bar",
    ]);
    expect(out[0]?.title).toBe("自願醫保比較");
    expect(g.calls[0]?.tools).toEqual(["googleSearch"]);
    expect(g.calls[0]?.userPrompt).toContain("site:bowtie.com.hk/blog");
  });

  it("filters non-bowtie and unresolved chunks", async () => {
    const g = gemini([chunk("v1"), chunk("bad"), chunk("nores")]);
    const resolve = resolver({
      v1: bowtie("v1", "https://www.bowtie.com.hk/blog/foo"),
      bad: { vertexUri: "bad", finalUrl: "https://example.com/x", domain: "example.com", error: null },
    });

    const out = await runExistingArticleSearch(makeFakeSql(), g, resolve, {
      topic: "t",
      keywords: [],
    });

    expect(out.map((a) => a.url)).toEqual(["https://www.bowtie.com.hk/blog/foo"]);
  });

  it("dedupes by URL ignoring trailing slash", async () => {
    const g = gemini([chunk("v1"), chunk("v2")]);
    const resolve = resolver({
      v1: bowtie("v1", "https://www.bowtie.com.hk/blog/foo"),
      v2: bowtie("v2", "https://www.bowtie.com.hk/blog/foo/"),
    });

    const out = await runExistingArticleSearch(makeFakeSql(), g, resolve, {
      topic: "t",
      keywords: [],
    });

    expect(out).toHaveLength(1);
  });

  it("caps at MAX_CANDIDATES", async () => {
    const n = MAX_CANDIDATES + 3;
    const chunks = Array.from({ length: n }, (_, i) => chunk(`v${i}`));
    const map: Record<string, ResolvedUrl> = {};
    for (let i = 0; i < n; i++) {
      map[`v${i}`] = bowtie(`v${i}`, `https://www.bowtie.com.hk/blog/p${i}`);
    }

    const out = await runExistingArticleSearch(makeFakeSql(), gemini(chunks), resolver(map), {
      topic: "t",
      keywords: [],
    });

    expect(out).toHaveLength(MAX_CANDIDATES);
  });

  it("returns an empty array when there are no grounding chunks", async () => {
    const out = await runExistingArticleSearch(makeFakeSql(), gemini([]), resolver({}), {
      topic: "t",
      keywords: [],
    });
    expect(out).toEqual([]);
  });
});
