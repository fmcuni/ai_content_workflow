import { describe, expect, it, beforeEach } from "vitest";
import type { Sql } from "postgres";

import { buildUserPrompt, runGapAnalysis, type GapAnalysisInput } from "./gap_analysis";
import { GAP_ANALYSIS_SCHEMA, type GapAnalysis } from "./schemas";
import { FakeGeminiClient } from "../gemini/fake";
import { invalidate } from "../prompts/store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_TEMPLATE_BODY = "你是 gap analysis agent。今天日期：{today_date}\n";

const CANNED_GAP: GapAnalysis = {
  target_query: "自願醫保比較",
  top_pages: [
    { url: "https://a.example/1", title: "頁面一", rank: 1 },
    { url: "https://a.example/2", title: "頁面二", rank: 2 },
    { url: "https://a.example/3", title: "頁面三", rank: 3 },
    { url: "https://a.example/4", title: "頁面四", rank: 4 },
    { url: "https://a.example/5", title: "頁面五", rank: 5 },
  ],
  current_article_assessment: {
    strengths: ["結構清晰"],
    outdated_points: ["保費數字過時"],
    weak_sections: ["FAQ"],
    structure_status: "partly_outdated",
  },
  content_gaps: {
    missing_topics: ["稅務扣減"],
    missing_intents: [],
    freshness_gaps: ["2026 數據"],
    semantic_gaps: [],
    source_trust_gaps: [],
    ai_extractability_gaps: [],
    hk_localization_gaps: [],
    faq_gaps: ["索償流程"],
  },
  recommended_outline: "H2 概覽 / H2 比較 / FAQ",
  update_plan: {
    must_add: ["稅務段落"],
    must_update: ["保費表"],
    must_remove: [],
    must_reorder: [],
    faq_to_add: ["索償需時多久"],
    facts_to_verify: ["扣稅上限"],
  },
  chosen_route: "small_refresh",
  route_reason: "大部分內容仍具競爭力，僅需局部更新。",
};

// ---------------------------------------------------------------------------
// Recording fake `sql` — a tagged-template that classifies each query and
// captures bind values, plus a `.json` marker so we can assert the jsonb path.
// ---------------------------------------------------------------------------

interface JsonbMarker {
  __jsonb: true;
  value: unknown;
}

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function makeFakeSql(templateBody: string): {
  sql: Sql;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];

  const tag = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = strings.join("?");
    queries.push({ text, values });

    // The prompt store reads all templates with this SELECT.
    if (text.includes("FROM content_tool.prompt_templates")) {
      return Promise.resolve([
        {
          voice_slug: "__shared__",
          template_id: "gap_analysis",
          category: "agent",
          filename: "gap_analysis.md",
          body: templateBody,
          sha256: "x",
          bytes: templateBody.length,
          updated_at: "2026-05-31T00:00:00Z",
          updated_by: null,
        },
      ]);
    }

    // INSERT / UPDATE return no rows.
    return Promise.resolve([]);
  };

  // postgres.js exposes `.json(value)` to tag a NATIVE jsonb bind param.
  (tag as unknown as { json: (v: unknown) => JsonbMarker }).json = (v: unknown): JsonbMarker => ({
    __jsonb: true,
    value: v,
  });

  return { sql: tag as unknown as Sql, queries };
}

function baseInput(overrides: Partial<GapAnalysisInput> = {}): GapAnalysisInput {
  return {
    runId: "11111111-1111-1111-1111-111111111111",
    voiceSlug: "bowtie-editor",
    topic: "自願醫保",
    keywords: ["VHIS", "扣稅"],
    articleUrl: "https://bowtie.example/article",
    acfAdvId: 12,
    acfWidgetId: 34,
    mode: "auto",
    editNote: null,
    todayDate: "2026-05-31",
    model: "gemini-3.1-pro-preview",
    thinkingLevel: "HIGH",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildUserPrompt — pure-function parity with Python build_user_prompt
// ---------------------------------------------------------------------------

describe("buildUserPrompt", () => {
  it("renders Auto label and N/A edit note for mode=auto", () => {
    const prompt = buildUserPrompt({
      topic: "自願醫保",
      keywords: ["VHIS", "扣稅"],
      articleUrl: "https://bowtie.example/article",
      acfAdvId: 12,
      acfWidgetId: 34,
      mode: "auto",
      editNote: null,
    });

    expect(prompt).toBe(
      "topic: 自願醫保\n" +
        "focus_keywords: VHIS, 扣稅\n" +
        "existing_article: https://bowtie.example/article\n" +
        "acf_adv_id: 12\n" +
        "acf_widget_id: 34\n" +
        "route: Auto (follow existing logic)\n" +
        "article_edit_note: N/A",
    );
  });

  it("renders override label and the edit note when provided", () => {
    const prompt = buildUserPrompt({
      topic: "T",
      keywords: [],
      articleUrl: "u",
      acfAdvId: 1,
      acfWidgetId: 2,
      mode: "full_rewrite",
      editNote: "請加入稅務段落",
    });

    expect(prompt).toContain("route: full_rewrite (override existing logic)");
    expect(prompt).toContain("article_edit_note: 請加入稅務段落");
  });
});

// ---------------------------------------------------------------------------
// runGapAnalysis — Gemini parity, override, and DB writes
// ---------------------------------------------------------------------------

describe("runGapAnalysis", () => {
  beforeEach(() => {
    // The prompt store caches per-isolate; reset between tests.
    invalidate();
  });

  it("calls Gemini with the gap-analysis schema and grounding tools", async () => {
    const gemini = new FakeGeminiClient({ gap_analysis: { ...CANNED_GAP } });
    const { sql } = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    await runGapAnalysis(sql, gemini, baseInput());

    expect(gemini.calls).toHaveLength(1);
    const call = gemini.calls[0];
    if (call === undefined) throw new Error("expected one recorded Gemini call");
    expect(call.agent).toBe("gap_analysis");
    expect(call.tools).toEqual(["googleSearch", "urlContext"]);
    // {today_date} substituted into the system prompt.
    expect(call.systemPrompt).toContain("今天日期：2026-05-31");
    // User prompt carries the run fields.
    expect(call.userPrompt).toContain("topic: 自願醫保");
  });

  it("returns the parsed gap analysis and token usage", async () => {
    const gemini = new FakeGeminiClient({ gap_analysis: { ...CANNED_GAP } });
    const { sql } = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    const { gapAnalysis, tokens } = await runGapAnalysis(sql, gemini, baseInput());

    expect(gapAnalysis).toEqual(CANNED_GAP);
    expect(tokens).toEqual({
      tokensIn: 1000,
      tokensOut: 500,
      thinkingTokens: 100,
      latencyMs: 10,
    });
  });

  it("keeps the model-chosen route when mode is auto", async () => {
    const gemini = new FakeGeminiClient({
      gap_analysis: { ...CANNED_GAP, chosen_route: "small_refresh" },
    });
    const { sql } = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    const { gapAnalysis } = await runGapAnalysis(sql, gemini, baseInput({ mode: "auto" }));

    expect(gapAnalysis.chosen_route).toBe("small_refresh");
  });

  it("overrides chosen_route when the run pins a non-auto mode", async () => {
    const gemini = new FakeGeminiClient({
      gap_analysis: { ...CANNED_GAP, chosen_route: "small_refresh" },
    });
    const { sql } = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    const { gapAnalysis } = await runGapAnalysis(
      sql,
      gemini,
      baseInput({ mode: "full_rewrite" }),
    );

    expect(gapAnalysis.chosen_route).toBe("full_rewrite");
  });

  it("writes the gap_analyses row via a native jsonb payload and backfills runs.chosen_route", async () => {
    const gemini = new FakeGeminiClient({ gap_analysis: { ...CANNED_GAP } });
    const { sql, queries } = makeFakeSql(SYSTEM_TEMPLATE_BODY);

    await runGapAnalysis(sql, gemini, baseInput());

    const insert = queries.find((q) => q.text.includes("INSERT INTO content_tool.gap_analyses"));
    expect(insert).toBeDefined();
    // payload must be a NATIVE jsonb marker (sql.json), never a JSON string.
    const hasJsonbPayload = insert?.values.some(
      (v) => typeof v === "object" && v !== null && (v as { __jsonb?: boolean }).__jsonb === true,
    );
    expect(hasJsonbPayload).toBe(true);
    expect(insert?.values).toContain("gemini-3.1-pro-preview");
    expect(insert?.values).toContain("HIGH");

    const update = queries.find((q) => q.text.includes("UPDATE content_tool.runs"));
    expect(update).toBeDefined();
    expect(update?.values).toContain("small_refresh");
  });
});

// ---------------------------------------------------------------------------
// Schema sanity — the constant declares the required top-level fields.
// ---------------------------------------------------------------------------

describe("GAP_ANALYSIS_SCHEMA", () => {
  it("requires every GapAnalysis field and constrains top_pages to 5", () => {
    expect(GAP_ANALYSIS_SCHEMA.required).toEqual([
      "target_query",
      "top_pages",
      "current_article_assessment",
      "content_gaps",
      "recommended_outline",
      "update_plan",
      "chosen_route",
      "route_reason",
    ]);
    expect(GAP_ANALYSIS_SCHEMA.properties.top_pages.minItems).toBe(5);
    expect(GAP_ANALYSIS_SCHEMA.properties.top_pages.maxItems).toBe(5);
  });
});
