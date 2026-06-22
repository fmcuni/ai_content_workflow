// Phase 2: optional draft overrides on POST /templates/:id/preview.
//
// Covers the three new wire keys (`partial_overrides`, `source_policy`,
// `glossary`) at the engine + parser level, plus the combined case and the
// absent ⇒ byte-identical invariant. The PARITY_* fixtures below are byte-for-
// byte identical to the Python test (`tests/unit/test_prompts_preview_overrides.py`)
// so both stacks are asserted to produce the same output for the same inputs.

import { describe, expect, it } from "vitest";

import type { PromptTemplateRow } from "../db/schema";
import {
  glossaryFromRaw,
  toPromptBlock,
  voiceLocaleFromRaw,
  type GlossaryEntry,
  type PersonaPack,
} from "../agents/persona";
import { SourcePolicy } from "../config/source_policy";
import { assembleWithOverrides, resolveBodyWithOverrides } from "./store";
import {
  parsePreviewGlossary,
  parsePreviewSourcePolicy,
  substitutePreview,
} from "./editor";

// `substitutePreview` only touches the DB to resolve {persona_block} and
// {source_policy_block}; supplying both keeps the bogus `sql` unused.
const sql = (() => {
  throw new Error("sql must not be called when persona/source overrides are supplied");
}) as never;

const view = new Map<string, PromptTemplateRow>();

function row(
  voice_slug: string,
  template_id: string,
  body: string,
  category = "partial",
): PromptTemplateRow {
  return {
    voice_slug,
    template_id,
    category,
    filename: `${template_id}.md`,
    body,
    sha256: "deadbeef",
    bytes: body.length,
    updated_at: "2026-05-31T00:00:00Z",
    updated_by: null,
  };
}

// ---------------------------------------------------------------------------
// PARITY fixtures — identical strings in the Python test file.
// ---------------------------------------------------------------------------

const PARITY_GLOSSARY_RAW = [
  { term: "保險", preferred: "保障", status: "preferred" },
  { term: "termlife", status: "do_not_translate" },
] as const;

const PARITY_SOURCE_POLICY_DRAFT = {
  prompt_block: "DRAFT POLICY BLOCK 自訂",
} as const;

// A persona pack with empty scaffolding so the glossary section dominates the
// rendered block and the bytes are trivially reproducible across stacks.
function parityPersona(glossary: GlossaryEntry[]): PersonaPack {
  return {
    name: "Tester",
    voiceRules: ["rule"],
    bannedTerms: [],
    requiredPhrasings: [],
    disclaimerTemplates: {},
    toneExamples: { good: [], bad: [] },
    glossary,
    locale: voiceLocaleFromRaw({}),
  };
}

// ---------------------------------------------------------------------------
// partial_overrides — multi-override assembly (engine already covered in
// store.test.ts; here we assert the preview's exact threading semantics).
// ---------------------------------------------------------------------------

describe("preview partial_overrides", () => {
  it("agent path threads sibling partial drafts via resolveBodyWithOverrides", () => {
    const snap = new Map([row("__shared__", "_p2", "stored p2\n")].map((r) => [r.template_id, r]));
    const out = resolveBodyWithOverrides(
      "HEAD {{include:_p2}} TAIL",
      snap,
      new Map([["_p2", "draft p2"]]),
    );
    expect(out).toBe("HEAD draft p2 TAIL");
  });

  it("partial path: focused template wins over a same-id partial_overrides entry", () => {
    const snap = new Map(
      [
        row("__shared__", "agent_x", "{{include:_focus}}\n", "agent"),
        row("__shared__", "_focus", "stored\n"),
      ].map((r) => [r.template_id, r]),
    );
    // Mirrors the route: overrides = {...partial_overrides, [focusId]: template}
    const overrides = new Map([["_focus", "from_partial_overrides\n"]]);
    overrides.set("_focus", "FOCUSED WINS\n");
    const out = assembleWithOverrides("agent_x", snap, overrides);
    expect(out).toBe("FOCUSED WINS\n");
  });

  it("absent partial_overrides (empty map) ⇒ byte-identical to plain assembly", () => {
    const snap = new Map(
      [
        row("__shared__", "agent_x", "A {{include:_p}} B", "agent"),
        row("__shared__", "_p", "stored"),
      ].map((r) => [r.template_id, r]),
    );
    expect(resolveBodyWithOverrides("A {{include:_p}} B", snap, new Map())).toBe("A stored B");
  });
});

// ---------------------------------------------------------------------------
// glossary draft override — folded into the persona block via toPromptBlock.
// ---------------------------------------------------------------------------

describe("preview glossary override", () => {
  it("parsePreviewGlossary: absent/null ⇒ undefined; non-array ⇒ 422", () => {
    expect(parsePreviewGlossary(undefined)).toEqual({ ok: true, glossary: undefined });
    expect(parsePreviewGlossary(null)).toEqual({ ok: true, glossary: undefined });
    expect(parsePreviewGlossary("nope")).toEqual({ ok: false });
    expect(parsePreviewGlossary(42)).toEqual({ ok: false });
  });

  it("a draft glossary renders the same block bytes as a stored glossary (PARITY)", () => {
    const parsed = parsePreviewGlossary([...PARITY_GLOSSARY_RAW]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const block = toPromptBlock(parityPersona(parsed.glossary ?? []));
    // PARITY: byte-identical to the Python test's expected string.
    expect(block).toBe(
      "# 撰稿人格\n" +
        "角色：Tester\n" +
        "語氣規則：\n" +
        "- rule\n" +
        "避免使用的字詞：\n" +
        "必須採用的香港用語：\n" +
        "語氣示例：\n\n\n" +
        "# 詞彙表 · Glossary\n" +
        "- 用「保障」\n" +
        "- 保留原文：termlife\n",
    );
  });

  it("glossaryFromRaw drops malformed entries and defaults fields", () => {
    const g = glossaryFromRaw([{ term: "x" }, null, 7, { preferred: "no-term" }]);
    expect(g).toEqual([
      { term: "x", preferred: "", variants: [], status: "preferred", notes: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// source_policy draft override — rendered server-side via SourcePolicy.toPromptBlock.
// ---------------------------------------------------------------------------

describe("preview source_policy override", () => {
  it("parsePreviewSourcePolicy: absent/null ⇒ undefined; non-object/array ⇒ 422", () => {
    expect(parsePreviewSourcePolicy(undefined)).toEqual({ ok: true, policy: undefined });
    expect(parsePreviewSourcePolicy(null)).toEqual({ ok: true, policy: undefined });
    expect(parsePreviewSourcePolicy("nope")).toEqual({ ok: false });
    expect(parsePreviewSourcePolicy([1, 2])).toEqual({ ok: false });
  });

  it("a draft prompt_block flows through to {source_policy_block} (PARITY)", async () => {
    const parsed = parsePreviewSourcePolicy({ ...PARITY_SOURCE_POLICY_DRAFT });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = await substitutePreview(
      sql,
      "policy={source_policy_block}",
      { persona_block: "PB", today_date: "2026-06-15", create_mode_block: "CM" },
      view,
      "bowtie-editor",
      undefined,
      parsed.policy,
    );
    // PARITY: the draft's trimmed prompt_block is the rendered block.
    expect(out).toBe("policy=DRAFT POLICY BLOCK 自訂");
  });

  it("a context source_policy_block still wins over the draft policy", async () => {
    const policy = new SourcePolicy({ prompt_block: "DRAFT" });
    const out = await substitutePreview(
      sql,
      "policy={source_policy_block}",
      {
        persona_block: "PB",
        today_date: "2026-06-15",
        create_mode_block: "CM",
        source_policy_block: "CTX WINS",
      },
      view,
      "bowtie-editor",
      undefined,
      policy,
    );
    expect(out).toBe("policy=CTX WINS");
  });
});

// ---------------------------------------------------------------------------
// Combined + absent invariants.
// ---------------------------------------------------------------------------

describe("preview combined + absent overrides", () => {
  it("combined glossary + source_policy reflected together (PARITY)", async () => {
    // The glossary draft renders its persona block; we pass that rendered block
    // as the `persona_block` context value (DB-free) and the draft policy as the
    // structured override — asserting BOTH reflect in one preview.
    const glossary = glossaryFromRaw([...PARITY_GLOSSARY_RAW]);
    const personaBlock = toPromptBlock(parityPersona(glossary));
    const policy = new SourcePolicy({ ...PARITY_SOURCE_POLICY_DRAFT });
    const out = await substitutePreview(
      sql,
      "P={persona_block}\nS={source_policy_block}",
      { persona_block: personaBlock, today_date: "2026-06-15", create_mode_block: "CM" },
      view,
      "bowtie-editor",
      { glossary, locale: voiceLocaleFromRaw({}) },
      policy,
    );
    // PARITY: persona block (with glossary) + draft policy block, together.
    expect(out).toBe(`P=${personaBlock}\nS=DRAFT POLICY BLOCK 自訂`);
  });

  it("absent all three overrides ⇒ substitutePreview byte-identical to today", async () => {
    const TEMPLATE = "P={persona_block}\nD={today_date}\nPOL={source_policy_block}\nC={create_mode_block}";
    const ctx = {
      persona_block: "PB",
      today_date: "2026-06-15",
      source_policy_block: "SP",
      create_mode_block: "CM",
    };
    const a = await substitutePreview(sql, TEMPLATE, { ...ctx }, view, "bowtie-editor");
    const b = await substitutePreview(
      sql,
      TEMPLATE,
      { ...ctx },
      view,
      "bowtie-editor",
      undefined,
      undefined,
    );
    expect(a).toBe(b);
    expect(a).toBe("P=PB\nD=2026-06-15\nPOL=SP\nC=CM");
  });
});
