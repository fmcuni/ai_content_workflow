import { describe, expect, it, beforeEach } from "vitest";
import type { Sql } from "postgres";

import { buildUserPrompt, runTopicHot, type TopicHotInput } from "./topic_hot";
import { TOPIC_HOT_SCHEMA, type TopicHotOutput } from "./topic_schemas";
import { FakeGeminiClient } from "../gemini/fake";
import { invalidate } from "../prompts/store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_TEMPLATE_BODY = "你是 topic_hot agent。\n";

const CANNED_HOT: TopicHotOutput = {
  hot_topic: "yes",
  hot_topic_note: "近期 SERP 搜尋量明顯上升。",
};

function makeFakeSql(templateBody: string, locale: Record<string, unknown> | null = null): Sql {
  const tag = (strings: TemplateStringsArray): unknown => {
    const text = strings.join("?");
    if (text.includes("FROM content_tool.prompt_templates")) {
      return Promise.resolve([
        {
          voice_slug: "__shared__",
          template_id: "topic_hot",
          category: "agent",
          filename: "topic_hot.md",
          body: templateBody,
          sha256: "x",
          bytes: templateBody.length,
          updated_at: "2026-05-31T00:00:00Z",
          updated_by: null,
        },
      ]);
    }
    if (text.includes("FROM content_tool.personas")) {
      return Promise.resolve([
        {
          name: "Test Voice",
          voice_rules: [],
          banned_terms: [],
          required_phrasings: [],
          disclaimer_templates: {},
          tone_examples: {},
          glossary: [],
          locale,
        },
      ]);
    }
    return Promise.resolve([]);
  };
  return tag as unknown as Sql;
}

function baseInput(overrides: Partial<TopicHotInput> = {}): TopicHotInput {
  return {
    topic: "自願醫保扣稅攻略",
    keywords: ["VHIS", "扣稅"],
    voiceSlug: "bowtie-editor",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildUserPrompt — pure-function parity
// ---------------------------------------------------------------------------

describe("buildUserPrompt", () => {
  it("includes the topic and joined keywords", () => {
    const prompt = buildUserPrompt({ topic: "自願醫保扣稅攻略", keywords: ["VHIS", "扣稅"] });

    expect(prompt).toContain("Google 香港繁中 SERP");
    expect(prompt).toContain("topic:\n自願醫保扣稅攻略");
    expect(prompt).toContain("focus_keywords:\nVHIS, 扣稅");
  });

  it("renders （無） when keywords are empty", () => {
    const prompt = buildUserPrompt({ topic: "T", keywords: [] });
    expect(prompt).toContain("focus_keywords:\n（無）");
  });

  it("defaults the market to Google 香港繁中 (byte-identical HK-ZH)", () => {
    const prompt = buildUserPrompt({ topic: "T", keywords: [] });
    expect(prompt).toBe(
      "請分析以下單一 topic 在 Google 香港繁中 SERP 是否屬於熱門話題。" +
        "只輸出符合 schema 的 JSON。\n\n" +
        "topic:\nT\n\n" +
        "focus_keywords:\n（無）\n",
    );
  });

  it("interpolates a non-HK market when one is supplied", () => {
    const prompt = buildUserPrompt({
      topic: "T",
      keywords: [],
      market: "Google Malaysia (gobowtie.com/my)",
    });
    expect(prompt).toContain("Google Malaysia (gobowtie.com/my) SERP");
    expect(prompt).not.toContain("Google 香港繁中");
  });
});

// ---------------------------------------------------------------------------
// runTopicHot — Gemini parity + parsed output mapping
// ---------------------------------------------------------------------------

describe("runTopicHot", () => {
  beforeEach(() => {
    invalidate();
  });

  it("loads the topic_hot template and calls Gemini with schema + grounding tools", async () => {
    const gemini = new FakeGeminiClient({ topic_hot: { ...CANNED_HOT } });
    const sql = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    await runTopicHot(sql, gemini, baseInput());

    expect(gemini.calls).toHaveLength(1);
    const call = gemini.calls[0];
    if (call === undefined) throw new Error("expected one recorded Gemini call");
    expect(call.agent).toBe("topic_hot");
    expect(call.tools).toEqual(["googleSearch", "urlContext"]);
    expect(call.systemPrompt).toContain("topic_hot agent");
    expect(call.userPrompt).toContain("topic:\n自願醫保扣稅攻略");
  });

  it("uses the voice's locale market in the user prompt", async () => {
    const gemini = new FakeGeminiClient({ topic_hot: { ...CANNED_HOT } });
    const sql = makeFakeSql(SYSTEM_TEMPLATE_BODY, {
      market: "Google Malaysia (gobowtie.com/my)",
    });

    await runTopicHot(sql, gemini, baseInput({ voiceSlug: "bowtie-en-my" }));

    const call = gemini.calls[0];
    if (call === undefined) throw new Error("expected one recorded Gemini call");
    expect(call.userPrompt).toContain("Google Malaysia (gobowtie.com/my) SERP");
    expect(call.userPrompt).not.toContain("Google 香港繁中");
  });

  it("keeps the HK-ZH market when the voice has no locale override", async () => {
    const gemini = new FakeGeminiClient({ topic_hot: { ...CANNED_HOT } });
    const sql = makeFakeSql(SYSTEM_TEMPLATE_BODY, null);

    await runTopicHot(sql, gemini, baseInput());

    const call = gemini.calls[0];
    if (call === undefined) throw new Error("expected one recorded Gemini call");
    expect(call.userPrompt).toContain("Google 香港繁中 SERP");
  });

  it("returns the parsed verdict mapped to TopicHotOutput plus token usage", async () => {
    const gemini = new FakeGeminiClient({ topic_hot: { ...CANNED_HOT } });
    const sql = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    const { output, tokens } = await runTopicHot(sql, gemini, baseInput());

    expect(output).toEqual(CANNED_HOT);
    expect(output.hot_topic).toBe("yes");
    expect(output.hot_topic_note).toBe("近期 SERP 搜尋量明顯上升。");
    expect(tokens).toEqual({
      tokensIn: 1000,
      tokensOut: 500,
      thinkingTokens: 100,
      latencyMs: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// Schema sanity
// ---------------------------------------------------------------------------

describe("TOPIC_HOT_SCHEMA", () => {
  it("requires the verdict fields and constrains the hot_topic enum", () => {
    expect(TOPIC_HOT_SCHEMA.required).toEqual(["hot_topic", "hot_topic_note"]);
    expect(TOPIC_HOT_SCHEMA.properties.hot_topic.enum).toEqual(["yes", "no"]);
  });
});
