import { describe, expect, it } from "vitest";

import { defaultVoiceLocale, toPromptBlock } from "./persona";
import type { PersonaPack } from "./persona";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const BASE_PACK: PersonaPack = {
  name: "Bowtie 健康顧問",
  voiceRules: ["親切專業", "避免術語堆砌"],
  bannedTerms: ["便宜", "最平"],
  requiredPhrasings: ["醫療保障", "保費"],
  disclaimerTemplates: {
    general: { condition: "always", disclaimer: "此內容僅供參考。" },
  },
  toneExamples: {
    good: ["讓您的家人得到最好的保障"],
    bad: ["最平最抵"],
  },
  glossary: [
    {
      term: "自願醫保",
      preferred: "自願醫保計劃",
      variants: ["VHIS"],
      status: "preferred",
      notes: null,
    },
    {
      term: "人壽保險",
      preferred: "",
      variants: ["life insurance"],
      status: "forbidden",
      notes: "監管要求統一用法",
    },
    {
      term: "cheap",
      preferred: "affordable",
      variants: [],
      status: "avoid",
      notes: null,
    },
    {
      term: "AI",
      preferred: "",
      variants: [],
      status: "do_not_translate",
      notes: null,
    },
  ],
  locale: defaultVoiceLocale(),
};

// ---------------------------------------------------------------------------
// toPromptBlock — header and required sections
// ---------------------------------------------------------------------------

describe("toPromptBlock", () => {
  it("contains the 撰稿人格 header", () => {
    // Arrange / Act
    const block = toPromptBlock(BASE_PACK);

    // Assert
    expect(block).toContain("# 撰稿人格\n");
  });

  it("renders 角色 line with the persona name", () => {
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("角色：Bowtie 健康顧問\n");
  });

  it("renders 語氣規則 section with all voice rules", () => {
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("語氣規則：\n- 親切專業\n- 避免術語堆砌\n");
  });

  it("renders 避免使用的字詞 line", () => {
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("避免使用的字詞：便宜, 最平\n");
  });

  it("renders 必須採用的香港用語 line", () => {
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("必須採用的香港用語：醫療保障, 保費\n");
  });

  it("renders 語氣示例 section with good/bad lines", () => {
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("語氣示例：\n  好：讓您的家人得到最好的保障\n  壞：最平最抵\n");
  });

  // ---------------------------------------------------------------------------
  // Glossary rendering — status variants
  // ---------------------------------------------------------------------------

  it("renders forbidden entry with 禁用 prefix and variants", () => {
    // "人壽保險" status=forbidden, variants=["life insurance"], notes=...
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("- 禁用：人壽保險（避用：life insurance） — 監管要求統一用法");
  });

  it("renders avoid entry with 避用 arrow 改用 pattern", () => {
    // "cheap" status=avoid, preferred="affordable"
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("- 避用：cheap → 改用「affordable」");
  });

  it("renders do_not_translate entry with 保留原文 prefix", () => {
    // "AI" status=do_not_translate
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("- 保留原文：AI");
  });

  it("renders preferred entry with 用「...」 pattern including variants", () => {
    // "自願醫保" status=preferred, preferred="自願醫保計劃", variants=["VHIS"]
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("- 用「自願醫保計劃」（避用：VHIS）");
  });

  it("renders glossary header 詞彙表 · Glossary", () => {
    const block = toPromptBlock(BASE_PACK);
    expect(block).toContain("# 詞彙表 · Glossary");
  });

  // ---------------------------------------------------------------------------
  // contextText filtering
  // ---------------------------------------------------------------------------

  it("includes all glossary entries when no contextText is provided", () => {
    const block = toPromptBlock(BASE_PACK, undefined);
    expect(block).toContain("自願醫保");
    expect(block).toContain("人壽保險");
    expect(block).toContain("cheap");
    expect(block).toContain("AI");
  });

  it("filters out non-matching glossary entries when contextText is provided", () => {
    // Only "自願醫保" and "VHIS" appear in the context — others should be excluded
    const context = "本文介紹自願醫保的優點，VHIS計劃適合香港居民。";
    const block = toPromptBlock(BASE_PACK, context);

    // Matching entry should be present
    expect(block).toContain("自願醫保");
    // Non-matching entries should be absent
    expect(block).not.toContain("人壽保險");
    expect(block).not.toContain("cheap");
    expect(block).not.toContain("保留原文：AI");
  });

  it("excludes glossary section entirely when no entries match contextText", () => {
    const block = toPromptBlock(BASE_PACK, "完全不相關的英文文章 about something else entirely.");
    expect(block).not.toContain("# 詞彙表 · Glossary");
  });

  it("contextText matching is case-insensitive", () => {
    // "cheap" in context with different case — should still match via toLowerCase
    const block = toPromptBlock(BASE_PACK, "This product is CHEAP to buy.");
    expect(block).toContain("cheap");
  });

  it("matches via preferred form in contextText", () => {
    // "affordable" is the preferred form of "cheap" — matching on preferred
    const block = toPromptBlock(BASE_PACK, "This plan is affordable for families.");
    expect(block).toContain("cheap");
  });

  // ---------------------------------------------------------------------------
  // avoid entry with no preferred (無替代詞 fallback)
  // ---------------------------------------------------------------------------

  it("renders avoid entry with no preferred as (無替代詞)", () => {
    const pack: PersonaPack = {
      ...BASE_PACK,
      glossary: [
        {
          term: "廉宜",
          preferred: "",
          variants: [],
          status: "avoid",
          notes: null,
        },
      ],
    };
    const block = toPromptBlock(pack);
    expect(block).toContain("- 避用：廉宜 → 改用「(無替代詞)」");
  });

  // ---------------------------------------------------------------------------
  // preferred entry fallback: uses term when preferred is empty
  // ---------------------------------------------------------------------------

  it("renders preferred entry using term when preferred is empty", () => {
    const pack: PersonaPack = {
      ...BASE_PACK,
      glossary: [
        {
          term: "醫院",
          preferred: "",
          variants: [],
          status: "preferred",
          notes: null,
        },
      ],
    };
    const block = toPromptBlock(pack);
    expect(block).toContain("- 用「醫院」");
  });

  // ---------------------------------------------------------------------------
  // Empty glossary — no glossary section rendered
  // ---------------------------------------------------------------------------

  it("does not render glossary section when glossary is empty", () => {
    const pack: PersonaPack = { ...BASE_PACK, glossary: [] };
    const block = toPromptBlock(pack);
    expect(block).not.toContain("# 詞彙表 · Glossary");
  });
});
