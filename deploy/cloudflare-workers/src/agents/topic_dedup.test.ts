import { describe, expect, it, beforeEach } from "vitest";
import type { Sql } from "postgres";

import { buildUserPrompt, runTopicDedup, type TopicDedupInput } from "./topic_dedup";
import { TOPIC_DEDUP_SCHEMA, type TopicDedupOutput } from "./topic_schemas";
import { FakeGeminiClient } from "../gemini/fake";
import { invalidate } from "../prompts/store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_TEMPLATE_BODY = "你是 topic_dedup agent。\n";

const CANNED_DEDUP: TopicDedupOutput = {
  existing: "yes",
  existing_note: "已有相同主題文章。",
  existing_url: "https://www.bowtie.com.hk/blog/vhis",
};

function makeFakeSql(templateBody: string): Sql {
  const tag = (strings: TemplateStringsArray): unknown => {
    const text = strings.join("?");
    if (text.includes("FROM content_tool.prompt_templates")) {
      return Promise.resolve([
        {
          template_id: "topic_dedup",
          category: "agent",
          filename: "topic_dedup.md",
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

function baseInput(overrides: Partial<TopicDedupInput> = {}): TopicDedupInput {
  return {
    topic: "自願醫保扣稅攻略",
    keywords: ["VHIS", "扣稅"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildUserPrompt — pure-function parity
// ---------------------------------------------------------------------------

describe("buildUserPrompt", () => {
  it("includes the topic and joined keywords", () => {
    const prompt = buildUserPrompt({ topic: "自願醫保扣稅攻略", keywords: ["VHIS", "扣稅"] });

    expect(prompt).toContain("site:bowtie.com.hk/blog");
    expect(prompt).toContain("topic:\n自願醫保扣稅攻略");
    expect(prompt).toContain("focus_keywords:\nVHIS, 扣稅");
  });

  it("renders （無） when keywords are empty", () => {
    const prompt = buildUserPrompt({ topic: "T", keywords: [] });
    expect(prompt).toContain("focus_keywords:\n（無）");
  });
});

// ---------------------------------------------------------------------------
// runTopicDedup — Gemini parity + parsed output mapping
// ---------------------------------------------------------------------------

describe("runTopicDedup", () => {
  beforeEach(() => {
    invalidate();
  });

  it("loads the topic_dedup template and calls Gemini with schema + grounding tools", async () => {
    const gemini = new FakeGeminiClient({ topic_dedup: { ...CANNED_DEDUP } });
    const sql = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    await runTopicDedup(sql, gemini, baseInput());

    expect(gemini.calls).toHaveLength(1);
    const call = gemini.calls[0];
    if (call === undefined) throw new Error("expected one recorded Gemini call");
    expect(call.agent).toBe("topic_dedup");
    expect(call.tools).toEqual(["googleSearch", "urlContext"]);
    expect(call.systemPrompt).toContain("topic_dedup agent");
    expect(call.userPrompt).toContain("topic:\n自願醫保扣稅攻略");
  });

  it("returns the parsed verdict mapped to TopicDedupOutput plus token usage", async () => {
    const gemini = new FakeGeminiClient({ topic_dedup: { ...CANNED_DEDUP } });
    const sql = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    const { output, tokens } = await runTopicDedup(sql, gemini, baseInput());

    expect(output).toEqual(CANNED_DEDUP);
    expect(output.existing).toBe("yes");
    expect(output.existing_url).toBe("https://www.bowtie.com.hk/blog/vhis");
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

describe("TOPIC_DEDUP_SCHEMA", () => {
  it("requires the verdict fields and constrains the existing enum", () => {
    expect(TOPIC_DEDUP_SCHEMA.required).toEqual(["existing", "existing_note", "existing_url"]);
    expect(TOPIC_DEDUP_SCHEMA.properties.existing.enum).toEqual(["yes", "no", "not_sure"]);
  });
});
