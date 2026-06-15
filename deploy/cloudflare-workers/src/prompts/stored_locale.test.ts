// storedLocale resolves the voice's stored locale (DB-first) for preview
// surfaces, falling back to the default voice then the HK-ZH defaults; and
// voiceLocaleToRaw round-trips a VoiceLocale back to its snake_case wire shape.

import { describe, expect, it } from "vitest";

import { defaultVoiceLocale, voiceLocaleFromRaw, voiceLocaleToRaw } from "../agents/persona";
import { storedLocale } from "./editor";

const LOCALE_MY_EN = {
  output_language: "English (Malaysia)",
  brand_name: "Bowtie MY",
  market: "Google Malaysia (gobowtie.com/my)",
  sources_heading: "Sources",
  faq_heading: "Frequently Asked Questions",
};

function personaRow(locale: unknown): Record<string, unknown> {
  return {
    name: "V",
    voice_rules: [],
    banned_terms: [],
    required_phrasings: [],
    disclaimer_templates: {},
    tone_examples: { good: [], bad: [] },
    glossary: [],
    locale,
  };
}

// Minimal fake `sql`: loadPersona issues `... WHERE slug = ${slug} ...`, so the
// first interpolated value is the slug. Return the configured row or [].
function makeSql(rowsBySlug: Record<string, Record<string, unknown>>): never {
  const sql = (_strings: TemplateStringsArray, ...values: unknown[]): unknown[] => {
    const slug = String(values[0]);
    const row = rowsBySlug[slug];
    return row === undefined ? [] : [row];
  };
  return sql as never;
}

describe("storedLocale", () => {
  it("returns the voice's stored locale when its persona row exists", async () => {
    const sql = makeSql({ "bowtie-en-my": personaRow(LOCALE_MY_EN) });
    const loc = await storedLocale(sql, "bowtie-en-my");
    expect(loc).toEqual(voiceLocaleFromRaw(LOCALE_MY_EN));
    expect(loc.market).toBe("Google Malaysia (gobowtie.com/my)");
  });

  it("falls back to the default voice when the requested voice has no row", async () => {
    const sql = makeSql({ "bowtie-editor": personaRow({ brand_name: "Bowtie" }) });
    const loc = await storedLocale(sql, "ghost-voice");
    // Default voice row carries HK-ZH defaults (empty fields → defaults).
    expect(loc).toEqual(defaultVoiceLocale());
  });

  it("returns HK-ZH defaults when neither the voice nor the default has a row", async () => {
    const loc = await storedLocale(makeSql({}), "ghost-voice");
    expect(loc).toEqual(defaultVoiceLocale());
  });

  it("does not consult the default voice when the voice IS the default", async () => {
    const sql = makeSql({ "bowtie-editor": personaRow(LOCALE_MY_EN) });
    const loc = await storedLocale(sql, "bowtie-editor");
    expect(loc).toEqual(voiceLocaleFromRaw(LOCALE_MY_EN));
  });
});

describe("voiceLocaleToRaw", () => {
  it("round-trips a VoiceLocale back to its snake_case wire shape", () => {
    expect(voiceLocaleToRaw(voiceLocaleFromRaw(LOCALE_MY_EN))).toEqual(LOCALE_MY_EN);
  });

  it("serializes the HK-ZH defaults (null sources_heading preserved)", () => {
    expect(voiceLocaleToRaw(defaultVoiceLocale())).toEqual({
      output_language: "香港繁體中文",
      brand_name: "Bowtie",
      market: "Google 香港繁中",
      sources_heading: null,
      faq_heading: "常見問題",
    });
  });
});
