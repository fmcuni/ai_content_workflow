import { describe, expect, it } from "vitest";

import { applyLocaleTokens } from "./writer";
import { defaultVoiceLocale } from "./persona";

// Mirror of the Python B3 logic test. The DB-seeded `__shared__` prompt rows are
// reseeded with these tokens in Phase C; here we prove the substitution LOGIC.

// A tokenized template fragment (post-Phase-C shape: literals swapped for tokens).
const TOKENIZED = [
  "你是香港網誌內容創作編輯，目標是爭取 outrank Google {output_language} Organic top 5。",
  "",
  "- 不可硬銷或推廣 {brand_name} 或任何保險公司／保險產品。",
  "  - `Organization` / `Corporation`（{brand_name} 機構資訊、聯絡、社交連結）",
  "2. 所有內容使用 {output_language}。",
].join("\n");

// The byte-for-byte HK-ZH baseline (what the literals were before tokenization).
const HK_ZH_ORIGINAL = [
  "你是香港網誌內容創作編輯，目標是爭取 outrank Google 香港繁體中文 Organic top 5。",
  "",
  "- 不可硬銷或推廣 Bowtie 或任何保險公司／保險產品。",
  "  - `Organization` / `Corporation`（Bowtie 機構資訊、聯絡、社交連結）",
  "2. 所有內容使用 香港繁體中文。",
].join("\n");

describe("applyLocaleTokens", () => {
  it("HK-ZH defaults reproduce the pre-token text byte-for-byte", () => {
    expect(applyLocaleTokens(TOKENIZED, defaultVoiceLocale())).toBe(HK_ZH_ORIGINAL);
  });

  it("is a no-op for text containing no locale tokens", () => {
    const plain = "今天是 2026-06-15，沒有任何 token。";
    expect(applyLocaleTokens(plain, defaultVoiceLocale())).toBe(plain);
  });

  it("a non-default locale changes the assembled text", () => {
    const out = applyLocaleTokens(TOKENIZED, {
      outputLanguage: "English (Malaysia)",
      brandName: "Acme",
      market: "Google Malaysia",
      sourcesHeading: "Sources",
      faqHeading: "Frequently Asked Questions",
    });
    expect(out).toContain("English (Malaysia)");
    expect(out).toContain("Acme");
    expect(out).not.toContain("Bowtie");
    expect(out).not.toContain("香港繁體中文");
  });
});
