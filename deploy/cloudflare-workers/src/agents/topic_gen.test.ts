import { describe, expect, it, beforeEach } from "vitest";
import type { Sql } from "postgres";

import { buildUserPrompt, runTopicGen, type TopicGenInput } from "./topic_gen";
import { TOPIC_GEN_SCHEMA, type TopicGenOutput } from "./topic_schemas";
import { FakeGeminiClient } from "../gemini/fake";
import { invalidate } from "../prompts/store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_TEMPLATE_BODY = "你是 topic_gen agent。\n";

const CANNED_TOPIC_GEN: TopicGenOutput = {
  topics: [
    { topic: "自願醫保扣稅攻略", keywords: ["VHIS", "扣稅", "報稅"] },
    { topic: "危疾保險比較", keywords: ["危疾", "比較"] },
  ],
};

// ---------------------------------------------------------------------------
// Recording fake `sql` — serves the prompt-template SELECT; returns no rows
// for everything else.
// ---------------------------------------------------------------------------

function makeFakeSql(templateBody: string): Sql {
  const tag = (strings: TemplateStringsArray): unknown => {
    const text = strings.join("?");
    if (text.includes("FROM content_tool.prompt_templates")) {
      return Promise.resolve([
        {
          template_id: "topic_gen",
          category: "agent",
          filename: "topic_gen.md",
          body: templateBody,
          sha256: "x",
          bytes: templateBody.length,
          updated_at: "2026-05-31T00:00:00Z",
          updated_by: null,
        },
      ]);
    }
    return Promise.resolve([]);
  };
  return tag as unknown as Sql;
}

function baseInput(overrides: Partial<TopicGenInput> = {}): TopicGenInput {
  return {
    researchTheme: "自願醫保",
    targetAudience: "首次投保人士",
    topicCount: 5,
    keywordsPerTopic: 3,
    mustCover: ["扣稅", "保費"],
    mustAvoid: ["醫療事故"],
    priorityFocus: "稅務",
    notes: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildUserPrompt — pure-function parity with Python build_user_prompt
// ---------------------------------------------------------------------------

describe("buildUserPrompt", () => {
  it("renders the research settings with bullet list blocks", () => {
    const prompt = buildUserPrompt({
      researchTheme: "自願醫保",
      targetAudience: "首次投保人士",
      topicCount: 5,
      keywordsPerTopic: 3,
      mustCover: ["扣稅", "保費"],
      mustAvoid: ["醫療事故"],
      priorityFocus: "稅務",
      notes: null,
    });

    expect(prompt).toContain("研究主題：自願醫保");
    expect(prompt).toContain("目標受眾：首次投保人士");
    expect(prompt).toContain("主題數量：5");
    expect(prompt).toContain("每個主題關鍵字數量：3");
    expect(prompt).toContain("必須涵蓋範疇：\n- 扣稅\n- 保費");
    expect(prompt).toContain("避免主題：\n- 醫療事故");
    expect(prompt).toContain("額外偏重方向：\n稅務");
    expect(prompt).toContain("補充要求：\n（無）");
  });

  it("renders （無） for empty lists and missing optional fields", () => {
    const prompt = buildUserPrompt({
      researchTheme: "T",
      targetAudience: "A",
      topicCount: 1,
      keywordsPerTopic: 1,
      mustCover: [],
      mustAvoid: [],
      priorityFocus: null,
      notes: null,
    });

    expect(prompt).toContain("必須涵蓋範疇：\n（無）");
    expect(prompt).toContain("避免主題：\n（無）");
    expect(prompt).toContain("額外偏重方向：\n（無）");
  });
});

// ---------------------------------------------------------------------------
// runTopicGen — Gemini parity + parsed output mapping
// ---------------------------------------------------------------------------

describe("runTopicGen", () => {
  beforeEach(() => {
    invalidate();
  });

  it("loads/substitutes the topic_gen template and calls Gemini with schema + grounding tools", async () => {
    const gemini = new FakeGeminiClient({ topic_gen: { ...CANNED_TOPIC_GEN } });
    const sql = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    await runTopicGen(sql, gemini, baseInput());

    expect(gemini.calls).toHaveLength(1);
    const call = gemini.calls[0];
    if (call === undefined) throw new Error("expected one recorded Gemini call");
    expect(call.agent).toBe("topic_gen");
    expect(call.tools).toEqual(["googleSearch", "urlContext"]);
    expect(call.systemPrompt).toContain("topic_gen agent");
    expect(call.userPrompt).toContain("研究主題：自願醫保");
  });

  it("returns the parsed candidates mapped to TopicGenOutput plus token usage", async () => {
    const gemini = new FakeGeminiClient({ topic_gen: { ...CANNED_TOPIC_GEN } });
    const sql = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    const { output, tokens } = await runTopicGen(sql, gemini, baseInput());

    expect(output).toEqual(CANNED_TOPIC_GEN);
    expect(output.topics[0]?.topic).toBe("自願醫保扣稅攻略");
    expect(output.topics[0]?.keywords).toEqual(["VHIS", "扣稅", "報稅"]);
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

describe("TOPIC_GEN_SCHEMA", () => {
  it("requires topics with topic + keywords per candidate", () => {
    expect(TOPIC_GEN_SCHEMA.required).toEqual(["topics"]);
    expect(TOPIC_GEN_SCHEMA.properties.topics.items.required).toEqual(["topic", "keywords"]);
  });
});
