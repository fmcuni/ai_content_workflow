// Persona prompt-block rendering — TypeScript port of:
//   content_tool/models/persona.py  (PersonaPack, GlossaryEntry, to_prompt_block)
//   content_tool/policy/personas.py (load_persona)
//
// Template strings are reproduced byte-for-byte from the Python source so that
// the prompts sent to Gemini are identical across runtimes.

import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GlossaryStatus = "preferred" | "avoid" | "forbidden" | "do_not_translate";

export interface GlossaryEntry {
  term: string;
  preferred: string;
  variants: string[];
  status: GlossaryStatus;
  notes: string | null;
}

export interface DisclaimerTemplate {
  condition: string;
  disclaimer: string;
}

/**
 * Per-voice locale / brand identity — TS mirror of
 * `content_tool.models.persona.VoiceLocale`. Stored in `personas.locale`
 * (JSONB). The defaults reproduce `bowtie-editor` (Bowtie HK 繁體中文)
 * byte-for-byte, so an empty `{}` locale is a no-op.
 */
export interface VoiceLocale {
  outputLanguage: string;
  brandName: string;
  market: string;
  sourcesHeading: string | null;
  faqHeading: string;
  uiLang: string;
}

/** HK-ZH defaults (mirror VoiceLocale's Python field defaults). */
export function defaultVoiceLocale(): VoiceLocale {
  return {
    outputLanguage: "香港繁體中文",
    brandName: "Bowtie",
    market: "Google 香港繁中",
    sourcesHeading: null,
    faqHeading: "常見問題",
    uiLang: "zh-Hant",
  };
}

interface RawVoiceLocale {
  output_language?: string;
  brand_name?: string;
  market?: string;
  sources_heading?: string | null;
  faq_heading?: string;
  ui_lang?: string;
}

/** Build a VoiceLocale from a raw JSONB value. null/{}/non-object → defaults. */
export function voiceLocaleFromRaw(raw: unknown): VoiceLocale {
  const d = defaultVoiceLocale();
  if (raw === null || typeof raw !== "object") {
    return d;
  }
  const r = raw as RawVoiceLocale;
  return {
    outputLanguage: r.output_language ?? d.outputLanguage,
    brandName: r.brand_name ?? d.brandName,
    market: r.market ?? d.market,
    sourcesHeading: r.sources_heading ?? d.sourcesHeading,
    faqHeading: r.faq_heading ?? d.faqHeading,
    uiLang: r.ui_lang ?? d.uiLang,
  };
}

export interface PersonaPack {
  name: string;
  voiceRules: string[];
  bannedTerms: string[];
  requiredPhrasings: string[];
  disclaimerTemplates: Record<string, DisclaimerTemplate>;
  toneExamples: { good: string[]; bad: string[] };
  glossary: GlossaryEntry[];
  locale: VoiceLocale;
}

// ---------------------------------------------------------------------------
// Persona-block scaffolding labels (selected by VoiceLocale.uiLang)
// ---------------------------------------------------------------------------

/**
 * Scaffolding labels for `toPromptBlock` — TS mirror of Python
 * `PersonaBlockLabels`. The `zh-Hant` set is byte-identical to the strings used
 * before parameterization so HK-ZH voices are a no-op; the `en` set emits no
 * Traditional-Chinese scaffolding.
 */
interface PersonaBlockLabels {
  personaHeader: string;
  role: string;
  voiceRules: string;
  bannedTerms: string;
  requiredPhrasings: string;
  toneExamples: string;
  toneGood: string;
  toneBad: string;
  glossaryHeader: string;
  forbidden: string;
  avoid: string;
  avoidArrow: string; // between term and target
  avoidArrowClose: string; // after target
  avoidNoTarget: string; // placeholder when no preferred target exists
  doNotTranslate: string;
  preferredOpen: string; // before preferred/term
  preferredClose: string; // after preferred/term
  variantsOpen: string; // wraps variant list (open)
  variantsClose: string; // wraps variant list (close)
}

// zh-Hant (default) — byte-identical to the pre-change hardcoded strings.
// NOTE: requiredPhrasings keeps the exact bytes "必須採用的香港用語：" so the
// assembled HK-ZH prompt is unchanged; the neutral wording lives only in `en`.
const LABELS_ZH_HANT: PersonaBlockLabels = {
  personaHeader: "# 撰稿人格",
  role: "角色：",
  voiceRules: "語氣規則：",
  bannedTerms: "避免使用的字詞：",
  requiredPhrasings: "必須採用的香港用語：",
  toneExamples: "語氣示例：",
  toneGood: "好：",
  toneBad: "壞：",
  glossaryHeader: "# 詞彙表 · Glossary",
  forbidden: "禁用：",
  avoid: "避用：",
  avoidArrow: " → 改用「",
  avoidArrowClose: "」",
  avoidNoTarget: "(無替代詞)",
  doNotTranslate: "保留原文：",
  preferredOpen: "用「",
  preferredClose: "」",
  variantsOpen: "（避用：",
  variantsClose: "）",
};

// en — English scaffolding; emits NO Traditional-Chinese labels.
const LABELS_EN: PersonaBlockLabels = {
  personaHeader: "# Persona",
  role: "Role: ",
  voiceRules: "Voice rules:",
  bannedTerms: "Terms to avoid: ",
  requiredPhrasings: "Required phrasings: ",
  toneExamples: "Tone examples:",
  toneGood: "Good: ",
  toneBad: "Bad: ",
  glossaryHeader: "# Glossary",
  forbidden: "Forbidden: ",
  avoid: "Avoid: ",
  avoidArrow: ' → use "',
  avoidArrowClose: '"',
  avoidNoTarget: "(no alternative)",
  doNotTranslate: "Do not translate: ",
  preferredOpen: 'Use "',
  preferredClose: '"',
  variantsOpen: " (avoid: ",
  variantsClose: ")",
};

/** Pick the persona-block label set for `uiLang` (mirror of `_labels_for`). */
function labelsFor(uiLang: string): PersonaBlockLabels {
  return uiLang === "en" ? LABELS_EN : LABELS_ZH_HANT;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Strings used for context-text substring matching (mirrors lookup_strings()). */
function lookupStrings(entry: GlossaryEntry): string[] {
  const candidates: string[] = [entry.term, ...entry.variants];
  if (entry.preferred) {
    candidates.push(entry.preferred);
  }
  return candidates.filter((s) => s.length > 0);
}

/** Filter glossary to entries that substring-match contextText (case-insensitive). */
function filterGlossary(glossary: GlossaryEntry[], contextText: string | undefined): GlossaryEntry[] {
  if (contextText === undefined) {
    return [...glossary];
  }
  const haystack = contextText.toLowerCase();
  return glossary.filter((e) =>
    lookupStrings(e).some((s) => haystack.includes(s.toLowerCase())),
  );
}

/** Render glossary section — mirrors PersonaPack._render_glossary(). */
function renderGlossary(
  glossary: GlossaryEntry[],
  contextText: string | undefined,
  lbl: PersonaBlockLabels,
): string {
  const entries = filterGlossary(glossary, contextText);
  if (entries.length === 0) {
    return "";
  }
  const lines: string[] = [lbl.glossaryHeader];
  for (const e of entries) {
    const variants =
      e.variants.length > 0 ? `${lbl.variantsOpen}${e.variants.join(", ")}${lbl.variantsClose}` : "";
    const note = e.notes ? ` — ${e.notes}` : "";
    if (e.status === "forbidden") {
      lines.push(`- ${lbl.forbidden}${e.term}${variants}${note}`);
    } else if (e.status === "avoid") {
      const target = e.preferred || lbl.avoidNoTarget;
      lines.push(`- ${lbl.avoid}${e.term}${lbl.avoidArrow}${target}${lbl.avoidArrowClose}${variants}${note}`);
    } else if (e.status === "do_not_translate") {
      lines.push(`- ${lbl.doNotTranslate}${e.term}${note}`);
    } else {
      // "preferred" (default)
      lines.push(`- ${lbl.preferredOpen}${e.preferred || e.term}${lbl.preferredClose}${variants}${note}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the persona as a Chinese-language system-prompt block.
 *
 * When `contextText` is supplied the glossary section is filtered to only
 * entries whose term/variants/preferred form substring-match the context.
 * This mirrors Python's `PersonaPack.to_prompt_block(context_text)` exactly.
 */
export function toPromptBlock(persona: PersonaPack, contextText?: string): string {
  const lbl = labelsFor(persona.locale.uiLang);
  const good = persona.toneExamples.good.map((x) => `  ${lbl.toneGood}${x}`).join("\n");
  const bad = persona.toneExamples.bad.map((x) => `  ${lbl.toneBad}${x}`).join("\n");
  const glossarySection = renderGlossary(persona.glossary, contextText, lbl);

  return (
    `${lbl.personaHeader}\n` +
    `${lbl.role}${persona.name}\n` +
    `${lbl.voiceRules}\n` +
    persona.voiceRules.map((r) => `- ${r}`).join("\n") +
    `\n` +
    `${lbl.bannedTerms}${persona.bannedTerms.join(", ")}\n` +
    `${lbl.requiredPhrasings}${persona.requiredPhrasings.join(", ")}\n` +
    `${lbl.toneExamples}\n${good}\n${bad}\n` +
    glossarySection
  );
}

// ---------------------------------------------------------------------------
// DB row shape (jsonb columns arrive as parsed objects from postgres.js)
// ---------------------------------------------------------------------------

interface RawDisclaimerTemplate {
  condition?: string;
  disclaimer?: string;
}

interface RawGlossaryEntry {
  term: string;
  preferred?: string;
  variants?: string[];
  status?: GlossaryStatus;
  notes?: string | null;
}

interface RawToneExamples {
  good?: string[];
  bad?: string[];
}

/** Map a raw DB row to a validated PersonaPack. */
function rowToPack(row: {
  name: string;
  voice_rules: unknown;
  banned_terms: unknown;
  required_phrasings: unknown;
  disclaimer_templates: unknown;
  tone_examples: unknown;
  glossary: unknown;
  locale: unknown;
}): PersonaPack {
  const voiceRules = row.voice_rules as string[];
  const bannedTerms = row.banned_terms as string[];
  const requiredPhrasings = row.required_phrasings as string[];
  const rawDisclaimers = row.disclaimer_templates as Record<string, RawDisclaimerTemplate>;
  const rawTone = row.tone_examples as RawToneExamples;
  const rawGlossary = (row.glossary ?? []) as RawGlossaryEntry[];

  const disclaimerTemplates: Record<string, DisclaimerTemplate> = {};
  for (const [key, val] of Object.entries(rawDisclaimers)) {
    disclaimerTemplates[key] = {
      condition: val.condition ?? "",
      disclaimer: val.disclaimer ?? "",
    };
  }

  const glossary: GlossaryEntry[] = rawGlossary.map((e) => ({
    term: e.term,
    preferred: e.preferred ?? "",
    variants: e.variants ?? [],
    status: e.status ?? "preferred",
    notes: e.notes ?? null,
  }));

  return {
    name: row.name,
    voiceRules,
    bannedTerms,
    requiredPhrasings,
    disclaimerTemplates,
    toneExamples: {
      good: rawTone.good ?? [],
      bad: rawTone.bad ?? [],
    },
    glossary,
    locale: voiceLocaleFromRaw(row.locale),
  };
}

/**
 * Load a persona from `content_tool.personas` by slug.
 *
 * Throws if no row is found (mirrors Python's scalar_one_or_none + YAML
 * fallback path — but in the Workers runtime there is no filesystem fallback,
 * so a missing slug is an unrecoverable error).
 */
export async function loadPersona(
  sql: Sql,
  slug: string,
): Promise<PersonaPack> {
  const rows = await sql<
    Array<{
      name: string;
      voice_rules: unknown;
      banned_terms: unknown;
      required_phrasings: unknown;
      disclaimer_templates: unknown;
      tone_examples: unknown;
      glossary: unknown;
      locale: unknown;
    }>
  >`
    SELECT name, voice_rules, banned_terms, required_phrasings,
           disclaimer_templates, tone_examples, glossary, locale
    FROM content_tool.personas
    WHERE slug = ${slug}
      AND is_archived = false
    LIMIT 1
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Persona not found: ${slug}`);
  }

  return rowToPack(row);
}
