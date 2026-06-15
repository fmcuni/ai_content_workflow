// Phase A foundation: VoiceLocale defaults reproduce HK-ZH (bowtie-editor).
// TS mirror of tests/unit/test_voice_locale.py — an empty/absent
// `personas.locale` is a no-op: every field falls back to Bowtie HK 繁體中文.

import { describe, expect, it } from "vitest";

import { defaultVoiceLocale, voiceLocaleFromRaw } from "./persona";

describe("VoiceLocale defaults (HK-ZH)", () => {
  it("default reproduces bowtie-editor literals", () => {
    expect(defaultVoiceLocale()).toEqual({
      outputLanguage: "香港繁體中文",
      brandName: "Bowtie",
      market: "Google 香港繁中",
      sourcesHeading: null,
      faqHeading: "常見問題",
      uiLang: "zh-Hant",
    });
  });

  it("null / {} / non-object → defaults", () => {
    const d = defaultVoiceLocale();
    expect(voiceLocaleFromRaw(null)).toEqual(d);
    expect(voiceLocaleFromRaw(undefined)).toEqual(d);
    expect(voiceLocaleFromRaw({})).toEqual(d);
    expect(voiceLocaleFromRaw("nonsense")).toEqual(d);
  });

  it("partial raw overrides only the given fields", () => {
    const loc = voiceLocaleFromRaw({
      output_language: "English (Malaysia)",
      brand_name: "Bowtie",
      market: "Google Malaysia (gobowtie.com/my)",
      sources_heading: "Sources",
      faq_heading: "Frequently Asked Questions",
      ui_lang: "en",
    });
    expect(loc.outputLanguage).toBe("English (Malaysia)");
    expect(loc.sourcesHeading).toBe("Sources");
    expect(loc.faqHeading).toBe("Frequently Asked Questions");
    expect(loc.uiLang).toBe("en");
  });

  it("explicit null sources_heading stays null (keeps script auto-detection)", () => {
    expect(voiceLocaleFromRaw({ sources_heading: null }).sourcesHeading).toBeNull();
  });
});
