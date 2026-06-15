// Phase B: locale override on POST /templates/:id/preview.
// `substitutePreview` with no `localeOverride` is byte-identical to today;
// with an override it resolves {brand_name}/{output_language}/{market} and the
// sources/FAQ heading tokens. `parsePreviewLocale` rejects a non-object locale.

import { describe, expect, it } from "vitest";

import type { PromptTemplateRow } from "../db/schema";
import { voiceLocaleFromRaw } from "../agents/persona";
import { parsePreviewLocale, substitutePreview } from "./editor";

// `substitutePreview` only touches the DB to resolve {persona_block} and
// {source_policy_block}. Supplying both as `context` overrides keeps the test
// fully DB-free, so the bogus `sql` is never invoked.
const sql = (() => {
  throw new Error("sql must not be called when persona/source overrides are supplied");
}) as never;

const view = new Map<string, PromptTemplateRow>();

// All locale-driven tokens the runtime agents inject, plus the named-default
// tokens supplied via context so no DB lookup happens.
const TEMPLATE = [
  "{persona_block}",
  "date={today_date}",
  "policy={source_policy_block}",
  "create={create_mode_block}",
  "brand={brand_name}",
  "lang={output_language}",
  "market={market}",
  "faq={faq_heading}",
  "sources={sources_heading}",
].join("\n");

const CONTEXT = {
  persona_block: "PB",
  today_date: "2026-06-15",
  source_policy_block: "SP",
  create_mode_block: "CM",
} as const;

describe("substitutePreview locale override", () => {
  it("no override → byte-identical to today (locale tokens fall through)", async () => {
    const withoutArg = await substitutePreview(sql, TEMPLATE, { ...CONTEXT }, view, "bowtie-editor");
    const withUndefined = await substitutePreview(
      sql,
      TEMPLATE,
      { ...CONTEXT },
      view,
      "bowtie-editor",
      undefined,
    );

    // Stable snapshot of today's behaviour: brand/lang/market/heading tokens
    // remain literal because nothing substitutes them in the preview path.
    expect(withoutArg).toBe(
      [
        "PB",
        "date=2026-06-15",
        "policy=SP",
        "create=CM",
        "brand={brand_name}",
        "lang={output_language}",
        "market={market}",
        "faq={faq_heading}",
        "sources={sources_heading}",
      ].join("\n"),
    );
    // Passing `undefined` is identical to omitting the arg.
    expect(withUndefined).toBe(withoutArg);
  });

  it("override → resolves brand/lang/market + sources/FAQ heading tokens", async () => {
    const locale = voiceLocaleFromRaw({
      output_language: "English (Malaysia)",
      brand_name: "Bowtie MY",
      market: "Google Malaysia (gobowtie.com/my)",
      sources_heading: "Sources",
      faq_heading: "Frequently Asked Questions",
    });

    const out = await substitutePreview(sql, TEMPLATE, { ...CONTEXT }, view, "bowtie-editor", locale);

    expect(out).toContain("brand=Bowtie MY");
    expect(out).toContain("lang=English (Malaysia)");
    expect(out).toContain("market=Google Malaysia (gobowtie.com/my)");
    expect(out).toContain("faq=Frequently Asked Questions");
    expect(out).toContain("sources=Sources");
    // No raw locale tokens leak through once an override is applied.
    expect(out).not.toContain("{brand_name}");
    expect(out).not.toContain("{output_language}");
    expect(out).not.toContain("{market}");
    expect(out).not.toContain("{faq_heading}");
  });

  it("override with null sources_heading → empty string substitution", async () => {
    const locale = voiceLocaleFromRaw({ brand_name: "Acme" });
    const out = await substitutePreview(
      sql,
      "S={sources_heading}",
      { persona_block: "PB", source_policy_block: "SP" },
      view,
      "bowtie-editor",
      locale,
    );
    expect(out).toBe("S=");
  });
});

describe("parsePreviewLocale", () => {
  it("undefined / null → ok with no override", () => {
    expect(parsePreviewLocale(undefined)).toEqual({ ok: true, locale: undefined });
    expect(parsePreviewLocale(null)).toEqual({ ok: true, locale: undefined });
  });

  it("object locale → ok with mapped (snake→camel) locale", () => {
    const r = parsePreviewLocale({ output_language: "English", brand_name: "Bowtie MY" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.locale?.outputLanguage).toBe("English");
      expect(r.locale?.brandName).toBe("Bowtie MY");
    }
  });

  it("missing fields fall back to HK-ZH defaults", () => {
    const r = parsePreviewLocale({ brand_name: "Bowtie" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.locale?.outputLanguage).toBe("香港繁體中文");
  });

  it("non-object locale → rejected (route maps to 422)", () => {
    expect(parsePreviewLocale("nonsense")).toEqual({ ok: false });
    expect(parsePreviewLocale(123)).toEqual({ ok: false });
  });
});
