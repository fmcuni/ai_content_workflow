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
import { loadPersona, toPromptBlock } from "../agents/persona";
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

/** Default persona slug used to render the preview persona block. */
const PREVIEW_PERSONA_SLUG = "bowtie-editor";

/**
 * Required placeholders per template — verbatim from `_REQUIRED_PLACEHOLDERS`.
 * Saving a template that drops one of these is rejected with HTTP 400.
 */
export const REQUIRED_PLACEHOLDERS: Readonly<Record<string, readonly string[]>> = {
  audit: ["persona_block", "today_date"],
  gap_analysis: ["today_date"],
  outline: ["today_date", "create_mode_block"],
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
// Editable gate
// ---------------------------------------------------------------------------

export function isEditable(row: Pick<PromptTemplateRow, "category">): boolean {
  return EDITABLE_CATEGORIES.has(row.category);
}

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

export async function substitutePreview(
  sql: Sql,
  text: string,
  overrides: Record<string, string>,
  snap: Map<string, PromptTemplateRow>,
): Promise<string> {
  const todayIso = Object.hasOwn(overrides, "today_date")
    ? (overrides["today_date"] ?? "")
    : new Date().toISOString().slice(0, 10);

  let personaBlock: string;
  if (Object.hasOwn(overrides, "persona_block")) {
    personaBlock = overrides["persona_block"] ?? "";
  } else {
    try {
      const persona = await loadPersona(sql, PREVIEW_PERSONA_SLUG);
      personaBlock = toPromptBlock(persona);
    } catch {
      personaBlock = "（preview: persona block not configured）";
    }
  }

  const sourcePolicyBlock = Object.hasOwn(overrides, "source_policy_block")
    ? (overrides["source_policy_block"] ?? "")
    : (await getPolicy(sql)).toPromptBlock();

  let createModeBlock: string;
  if (Object.hasOwn(overrides, "create_mode_block")) {
    createModeBlock = overrides["create_mode_block"] ?? "";
  } else {
    const cm = snap.get("outline_create_mode");
    createModeBlock = cm !== undefined ? cm.body.replace(/\s+$/, "") : "";
  }

  let out = text
    .replaceAll("{persona_block}", personaBlock)
    .replaceAll("{today_date}", todayIso)
    .replaceAll("{source_policy_block}", sourcePolicyBlock)
    .replaceAll("{create_mode_block}", createModeBlock);

  for (const [key, value] of Object.entries(overrides)) {
    if (NAMED_PREVIEW_KEYS.has(key)) continue;
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}
