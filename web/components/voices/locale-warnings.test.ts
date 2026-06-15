import { describe, expect, it } from "vitest";

import type { VoiceLocale } from "@/lib/types";
import { localeWarnings } from "./locale-warnings";

function locale(overrides: Partial<VoiceLocale> = {}): VoiceLocale {
  return {
    output_language: "香港繁體中文",
    brand_name: "Bowtie",
    market: "Google 香港繁中",
    sources_heading: null,
    faq_heading: "常見問題",
    ui_lang: "zh-Hant",
    ...overrides,
  };
}

describe("localeWarnings", () => {
  it("returns no warning for a coherent zh-Hant locale", () => {
    expect(localeWarnings(locale())).toEqual([]);
  });

  it("returns no warning for a coherent en locale", () => {
    expect(
      localeWarnings(
        locale({
          output_language: "English",
          faq_heading: "FAQ",
          sources_heading: "Sources",
          ui_lang: "en",
        }),
      ),
    ).toEqual([]);
  });

  it("warns when ui_lang=en but CJK chars appear in headings", () => {
    const warnings = localeWarnings(
      locale({ output_language: "English", faq_heading: "常見問題", ui_lang: "en" }),
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/English/i);
    expect(warnings[0]).toMatch(/FAQ heading/);
  });

  it("warns when ui_lang=zh-Hant but headings look pure-ASCII", () => {
    const warnings = localeWarnings(
      locale({ output_language: "English", faq_heading: "FAQ", ui_lang: "zh-Hant" }),
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/Traditional Chinese/i);
  });

  it("ignores a blank sources_heading (does not flag it under zh-Hant)", () => {
    // sources_heading null + CJK elsewhere → coherent, no warning.
    expect(localeWarnings(locale({ sources_heading: null }))).toEqual([]);
  });

  it("flags a non-empty ASCII sources_heading under zh-Hant", () => {
    const warnings = localeWarnings(locale({ sources_heading: "Sources" }));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/sources heading/);
  });
});
