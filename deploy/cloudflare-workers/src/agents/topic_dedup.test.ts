import { describe, expect, it, beforeEach } from "vitest";
import type { Sql } from "postgres";

import { buildUserPrompt, runTopicDedup, type TopicDedupInput } from "./topic_dedup";
import type { ExistingArticle, UrlResolveFn } from "./topic_existing_search";
import type { ResolvedUrl } from "./url_resolver";
import { TOPIC_DEDUP_SCHEMA, type TopicDedupOutput } from "./topic_schemas";
import { FakeGeminiClient } from "../gemini/fake";
import { invalidate } from "../prompts/store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEDUP_BODY = "你是 topic_dedup agent。\n";
const SEARCH_BODY = "你是 topic_existing_search agent。\n";

// Grounding chunks the stage-1 retrieval call returns; each web.uri is a
// vertexaisearch redirect resolved by the injected stub below.
const GROUNDING = [
  { web: { uri: "vertex://1", title: "自願醫保比較" } },
  { web: { uri: "vertex://2", title: "退保" } },
];
const RESOLVED: Record<string, ResolvedUrl> = {
  "vertex://1": {
    vertexUri: "vertex://1",
    finalUrl: "https://www.bowtie.com.hk/blog/foo",
    domain: "bowtie.com.hk",
    error: null,
  },
  "vertex://2": {
    vertexUri: "vertex://2",
    finalUrl: "https://www.bowtie.com.hk/blog/bar",
    domain: "bowtie.com.hk",
    error: null,
  },
};
const fakeResolve: UrlResolveFn = async (uri) =>
  RESOLVED[uri] ?? { vertexUri: uri, finalUrl: null, domain: null, error: "unresolved" };

const CANNED_DEDUP: TopicDedupOutput = {
  existing: "yes",
  existing_note: "已有相同主題文章。",
  existing_url: "https://www.bowtie.com.hk/blog/foo",
};

function makeFakeSql(): Sql {
  const tag = (strings: TemplateStringsArray): unknown => {
    const text = strings.join("?");
    if (text.includes("FROM content_tool.prompt_templates")) {
      return Promise.resolve([
        {
          template_id: "topic_dedup",
          category: "agent",
          filename: "topic_dedup.md",
          body: DEDUP_BODY,
          sha256: "x",
          bytes: DEDUP_BODY.length,
          updated_at: "2026-06-02T00:00:00Z",
          updated_by: null,
        },
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

function fakeGemini(grounding = GROUNDING): FakeGeminiClient {
  return new FakeGeminiClient(
    { topic_dedup: { ...CANNED_DEDUP } },
    { topic_existing_search: grounding },
  );
}

function baseInput(overrides: Partial<TopicDedupInput> = {}): TopicDedupInput {
  return { topic: "自願醫保扣稅攻略", keywords: ["VHIS", "扣稅"], ...overrides };
}

// ---------------------------------------------------------------------------
// buildUserPrompt — pure-function parity
// ---------------------------------------------------------------------------

describe("buildUserPrompt", () => {
  const candidates: ExistingArticle[] = [
    { url: "https://www.bowtie.com.hk/blog/foo", title: "VHIS" },
  ];

  it("includes the topic, joined keywords and candidate URLs", () => {
    const prompt = buildUserPrompt(
      { topic: "自願醫保扣稅攻略", keywords: ["VHIS", "扣稅"] },
      candidates,
    );

    expect(prompt).toContain("site:bowtie.com.hk/blog");
    expect(prompt).toContain("topic:\n自願醫保扣稅攻略");
    expect(prompt).toContain("focus_keywords:\nVHIS, 扣稅");
    expect(prompt).toContain("https://www.bowtie.com.hk/blog/foo");
  });

  it("renders （無） when keywords are empty and the empty-candidate notice", () => {
    const prompt = buildUserPrompt({ topic: "T", keywords: [] }, []);
    expect(prompt).toContain("focus_keywords:\n（無）");
    expect(prompt).toContain("候選文章：（無，搜尋不到相關文章）");
  });
});

// ---------------------------------------------------------------------------
// runTopicDedup — two-stage flow
// ---------------------------------------------------------------------------

describe("runTopicDedup", () => {
  beforeEach(() => {
    invalidate();
  });

  it("runs grounded retrieval then judge with the right agents + tools", async () => {
    const gemini = fakeGemini();
    const sql = makeFakeSql();

    await runTopicDedup(sql, gemini, baseInput(), fakeResolve);

    expect(gemini.calls).toHaveLength(2);
    const [search, judge] = gemini.calls;
    if (search === undefined || judge === undefined) {
      throw new Error("expected two recorded Gemini calls");
    }
    expect(search.agent).toBe("topic_existing_search");
    expect(search.tools).toEqual(["googleSearch"]);
    expect(judge.agent).toBe("topic_dedup");
    expect(judge.tools).toEqual(["urlContext"]);
    // The judge prompt embeds the real grounded candidate URLs.
    expect(judge.userPrompt).toContain("https://www.bowtie.com.hk/blog/foo");
  });

  it("returns the grounded URL when the judge picks one from the candidate list", async () => {
    const gemini = fakeGemini();
    const sql = makeFakeSql();

    const { output, tokens } = await runTopicDedup(sql, gemini, baseInput(), fakeResolve);

    expect(output.existing).toBe("yes");
    expect(output.existing_url).toBe("https://www.bowtie.com.hk/blog/foo");
    expect(tokens).toEqual({
      tokensIn: 1000,
      tokensOut: 500,
      thinkingTokens: 100,
      latencyMs: 10,
    });
  });

  it("blanks a fabricated URL and downgrades yes → not_sure", async () => {
    const gemini = new FakeGeminiClient(
      {
        topic_dedup: {
          existing: "yes",
          existing_note: "URL 是捏造的。",
          existing_url: "https://www.bowtie.com.hk/blog/HALLUCINATED",
        },
      },
      { topic_existing_search: GROUNDING },
    );

    const { output } = await runTopicDedup(makeFakeSql(), gemini, baseInput(), fakeResolve);

    expect(output.existing_url).toBe("");
    expect(output.existing).toBe("not_sure");
  });

  it("renders the empty-candidate notice when retrieval finds nothing", async () => {
    const gemini = fakeGemini([]);
    const sql = makeFakeSql();

    await runTopicDedup(sql, gemini, baseInput(), fakeResolve);

    const judge = gemini.calls[1];
    if (judge === undefined) throw new Error("expected a judge call");
    expect(judge.userPrompt).toContain("候選文章：（無，搜尋不到相關文章）");
  });
});

// ---------------------------------------------------------------------------
// Schema sanity
// ---------------------------------------------------------------------------

describe("TOPIC_DEDUP_SCHEMA", () => {
  it("requires the verdict fields and constrains the existing enum", () => {
    expect(TOPIC_DEDUP_SCHEMA.required).toEqual(["existing", "existing_note", "existing_url"]);
    expect(TOPIC_DEDUP_SCHEMA.properties.existing.enum).toEqual(["yes", "no", "not_sure"]);
  });
});
