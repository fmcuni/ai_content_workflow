/**
 * Prompt-editor helpers — TypeScript port of the editor-only pieces of
 * `content_tool/api/routes/prompts.py` (the read-only assembly engine lives in
 * `./store.ts`).
 *
 * Covers: editable-category gating, required-placeholder validation, include /
 * placeholder discovery, consumer lookup, SHA-256 hashing, and the preview
 * placeholder substitution that fills `{persona_block}`, `{today_date}`,
 * `{source_policy_block}` and `{create_mode_block}` with the same live defaults
 * the production agents inject.
 */

import type { Sql } from "postgres";
import type { PromptTemplateRow } from "../db/schema";
import type { VoiceLocale } from "../agents/persona";
import { loadPersona, toPromptBlock, voiceLocaleFromRaw } from "../agents/persona";
import { applyLocaleTokens } from "../agents/writer";
import { getPolicy } from "../source_policy/store";

// Re-exported for existing callers (routes/prompts.ts) — the implementations
// now live in a neutral module so the source-policy store can share them
// without an import cycle.
export { sha256Hex, utf8ByteLength } from "../util/hash";

// ---------------------------------------------------------------------------
// Constants — mirror content_tool/api/routes/prompts.py
// ---------------------------------------------------------------------------

/** 64 KiB cap on a saved template body (matches `_MAX_TEMPLATE_BYTES`). */
export const MAX_TEMPLATE_BYTES = 64 * 1024;

/** Categories the editor surfaces + manages (matches `_EDITABLE_CATEGORIES`). */
export const EDITABLE_CATEGORIES: ReadonlySet<string> = new Set(["agent", "partial"]);

/** `{lower_snake}` placeholder syntax (matches `_PLACEHOLDER_RE`). Global for matchAll. */
const PLACEHOLDER_RE = /\{([a-z][a-z0-9_]*)\}/g;

/** `{{include:NAME}}` directive syntax (matches `_INCLUDE_RE`). Global for matchAll. */
const INCLUDE_RE = /\{\{include:([A-Za-z0-9_./-]+)\}\}/g;

/** The "live default" placeholder keys preview fills before applying overrides. */
const NAMED_PREVIEW_KEYS = new Set([
  "persona_block",
  "today_date",
  "source_policy_block",
  "create_mode_block",
]);

/** Default persona slug — the preview persona block falls back to this voice
 * (then a placeholder) when the requested voice has no persona row. */
const DEFAULT_PREVIEW_VOICE = "bowtie-editor";

/**
 * Required placeholders per template — verbatim from `_REQUIRED_PLACEHOLDERS`.
 * Saving a template that drops one of these is rejected with HTTP 400.
 */
export const REQUIRED_PLACEHOLDERS: Readonly<Record<string, readonly string[]>> = {
  audit: ["persona_block", "today_date"],
  gap_analysis: ["today_date"],
  outline_rewrite_mode: ["today_date", "create_mode_block"],
  outline_create_mode: [],
  writer_small_refresh: ["persona_block", "today_date", "source_policy_block"],
  writer_full_rewrite: ["persona_block", "today_date", "source_policy_block"],
  writer_create: ["persona_block", "today_date", "source_policy_block"],
  topic_gen: [],
  topic_dedup: [],
  topic_hot: [],
  _writer_brand_block: [],
  _writer_schema: [],
  _writer_seo: [],
  _writer_refine_notes: [],
  _writer_output_format_tail: [],
};

// ---------------------------------------------------------------------------
// Include / placeholder discovery
// ---------------------------------------------------------------------------

/** Sorted unique `{placeholder}` names found in `body`. */
export function findPlaceholders(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found].sort();
}

/** Sorted unique `{{include:NAME}}` names referenced in `body`. */
export function findIncludes(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(INCLUDE_RE)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found].sort();
}

/** template_ids in the snapshot whose category is `agent`. */
export function agentIds(snap: Map<string, PromptTemplateRow>): Set<string> {
  const ids = new Set<string>();
  for (const [id, row] of snap) {
    if (row.category === "agent") ids.add(id);
  }
  return ids;
}

/** template_ids in the snapshot whose category is `partial`. */
export function partialIds(snap: Map<string, PromptTemplateRow>): Set<string> {
  const ids = new Set<string>();
  for (const [id, row] of snap) {
    if (row.category === "partial") ids.add(id);
  }
  return ids;
}

/** Names of the partials directly referenced by `routeId`'s body. */
export function partialsReferencedBy(
  routeId: string,
  snap: Map<string, PromptTemplateRow>,
): Set<string> {
  const row = snap.get(routeId);
  if (row === undefined) return new Set();
  return new Set(findIncludes(row.body));
}

/**
 * Agent templates whose body includes `templateId` (mirrors `_consumers_of`).
 * An agent template's only consumer is itself.
 */
export function consumersOf(
  templateId: string,
  snap: Map<string, PromptTemplateRow>,
): string[] {
  const row = snap.get(templateId);
  if (row !== undefined && row.category === "agent") {
    return [templateId];
  }
  const hits: string[] = [];
  for (const agentId of agentIds(snap)) {
    const body = snap.get(agentId)?.body ?? "";
    if (findIncludes(body).includes(templateId)) {
      hits.push(agentId);
    }
  }
  return hits.sort();
}

// ---------------------------------------------------------------------------
// Preview placeholder substitution — mirrors `_substitute_placeholders`.
//
// Fills the four named blocks (from overrides or live defaults) first, then
// applies every other override key. Unknown `{placeholders}` are left intact.
// ---------------------------------------------------------------------------

/**
 * Best-effort persona block for the preview, from the voice's persona row.
 * Falls back to the default voice, then a placeholder, when a voice has no
 * persona row. Mirrors Python `prompts.py::_default_persona_block` (the persona
 * block is preview-cosmetic — runtime assembly reads the persona at run time).
 */
async function defaultPersonaBlock(
  sql: Sql,
  voice: string,
  localeOverride?: VoiceLocale,
): Promise<string> {
  for (const slug of voice === DEFAULT_PREVIEW_VOICE ? [voice] : [voice, DEFAULT_PREVIEW_VOICE]) {
    try {
      const persona = await loadPersona(sql, slug);
      // When the caller supplies an unsaved locale (live preview), render the
      // persona block under that locale's `uiLang` labels instead of the row's
      // stored locale. Absent ⇒ stored locale, byte-identical to today.
      const pack = localeOverride === undefined ? persona : { ...persona, locale: localeOverride };
      return toPromptBlock(pack);
    } catch {
      continue;
    }
  }
  return "（preview: persona block not configured）";
}

export async function substitutePreview(
  sql: Sql,
  text: string,
  overrides: Record<string, string>,
  view: Map<string, PromptTemplateRow>,
  voice: string = DEFAULT_PREVIEW_VOICE,
  localeOverride?: VoiceLocale,
): Promise<string> {
  const todayIso = Object.hasOwn(overrides, "today_date")
    ? (overrides["today_date"] ?? "")
    : new Date().toISOString().slice(0, 10);

  let personaBlock: string;
  if (Object.hasOwn(overrides, "persona_block")) {
    personaBlock = overrides["persona_block"] ?? "";
  } else {
    personaBlock = await defaultPersonaBlock(sql, voice, localeOverride);
  }

  const sourcePolicyBlock = Object.hasOwn(overrides, "source_policy_block")
    ? (overrides["source_policy_block"] ?? "")
    : (await getPolicy(sql, voice)).toPromptBlock();

  let createModeBlock: string;
  if (Object.hasOwn(overrides, "create_mode_block")) {
    createModeBlock = overrides["create_mode_block"] ?? "";
  } else {
    const cm = view.get("outline_create_mode");
    createModeBlock = cm !== undefined ? cm.body.replace(/\s+$/, "") : "";
  }

  let out = text
    .replaceAll("{persona_block}", personaBlock)
    .replaceAll("{today_date}", todayIso)
    .replaceAll("{source_policy_block}", sourcePolicyBlock)
    .replaceAll("{create_mode_block}", createModeBlock);

  // Live-locale preview: when an unsaved locale is supplied, resolve the
  // brand/language/market tokens and sources/FAQ heading tokens the runtime
  // agents inject so the assembled prompt reflects the in-progress edits.
  // Done BEFORE the context loop so an explicit `context` value still wins.
  // Absent ⇒ these tokens fall through exactly as today.
  if (localeOverride !== undefined) {
    out = applyLocaleTokens(out, localeOverride)
      .replaceAll("{faq_heading}", localeOverride.faqHeading)
      .replaceAll("{sources_heading}", localeOverride.sourcesHeading ?? "");
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (NAMED_PREVIEW_KEYS.has(key)) continue;
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}

/** Allowed `ui_lang` values (mirrors Python `VoiceLocale.ui_lang` Literal). */
const VALID_UI_LANGS: ReadonlySet<string> = new Set(["zh-Hant", "en"]);

/**
 * Parse an optional preview `locale` override from the request body.
 *
 * - `undefined`/absent ⇒ `{ ok: true, locale: undefined }` (no override; preview
 *   stays byte-identical to today).
 * - a `ui_lang` outside {zh-Hant, en} ⇒ `{ ok: false }` (route → 422). Every
 *   other field is free-form / defaulted via `voiceLocaleFromRaw`.
 *
 * The wire contract is snake_case (`output_language`, `brand_name`, `market`,
 * `sources_heading`, `faq_heading`, `ui_lang`); `voiceLocaleFromRaw` already
 * maps snake → camel.
 */
export function parsePreviewLocale(
  raw: unknown,
): { ok: true; locale: VoiceLocale | undefined } | { ok: false } {
  if (raw === undefined || raw === null) {
    return { ok: true, locale: undefined };
  }
  if (typeof raw !== "object") {
    return { ok: false };
  }
  const uiLang = (raw as { ui_lang?: unknown }).ui_lang;
  if (uiLang !== undefined && (typeof uiLang !== "string" || !VALID_UI_LANGS.has(uiLang))) {
    return { ok: false };
  }
  return { ok: true, locale: voiceLocaleFromRaw(raw) };
}
