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

export interface PersonaPack {
  name: string;
  voiceRules: string[];
  bannedTerms: string[];
  requiredPhrasings: string[];
  disclaimerTemplates: Record<string, DisclaimerTemplate>;
  toneExamples: { good: string[]; bad: string[] };
  glossary: GlossaryEntry[];
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
function renderGlossary(glossary: GlossaryEntry[], contextText: string | undefined): string {
  const entries = filterGlossary(glossary, contextText);
  if (entries.length === 0) {
    return "";
  }
  const lines: string[] = ["# 詞彙表 · Glossary"];
  for (const e of entries) {
    const variants = e.variants.length > 0 ? `（避用：${e.variants.join(", ")}）` : "";
    const note = e.notes ? ` — ${e.notes}` : "";
    if (e.status === "forbidden") {
      lines.push(`- 禁用：${e.term}${variants}${note}`);
    } else if (e.status === "avoid") {
      const target = e.preferred || "(無替代詞)";
      lines.push(`- 避用：${e.term} → 改用「${target}」${variants}${note}`);
    } else if (e.status === "do_not_translate") {
      lines.push(`- 保留原文：${e.term}${note}`);
    } else {
      // "preferred" (default)
      lines.push(`- 用「${e.preferred || e.term}」${variants}${note}`);
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
  const good = persona.toneExamples.good.map((x) => `  好：${x}`).join("\n");
  const bad = persona.toneExamples.bad.map((x) => `  壞：${x}`).join("\n");
  const glossarySection = renderGlossary(persona.glossary, contextText);

  return (
    `# 撰稿人格\n` +
    `角色：${persona.name}\n` +
    `語氣規則：\n` +
    persona.voiceRules.map((r) => `- ${r}`).join("\n") +
    `\n` +
    `避免使用的字詞：${persona.bannedTerms.join(", ")}\n` +
    `必須採用的香港用語：${persona.requiredPhrasings.join(", ")}\n` +
    `語氣示例：\n${good}\n${bad}\n` +
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
    }>
  >`
    SELECT name, voice_rules, banned_terms, required_phrasings,
           disclaimer_templates, tone_examples, glossary
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
