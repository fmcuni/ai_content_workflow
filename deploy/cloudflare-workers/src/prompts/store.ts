/**
 * DB-backed prompt-template store — TypeScript port of Python's
 * `content_tool/prompts_store.py` for Cloudflare Workers.
 *
 * Two-stage assembly:
 *  1. Include resolution: every `{{include:NAME}}` directive is replaced with
 *     the referenced template's resolved body. Included partials have trailing
 *     newlines stripped before inlining; the TOP-LEVEL body's trailing newline
 *     is preserved (mirrors Python byte-for-byte).
 *  2. Placeholder substitution: done by callers via `substitute()`. Syntax is
 *     `{lower_snake}` — unknown placeholders are left intact.
 *
 * Categories: `agent` | `partial` | `judge`
 * Partials are named like `_writer_brand_block` and included via
 * `{{include:_writer_brand_block}}`.
 *
 * Per-voice scoping
 * -----------------
 * Each row is keyed by `(voice_slug, template_id)`. Agent and partial prompts
 * are scoped to a voice (persona slug); the reserved sentinel `__shared__` holds
 * the global judges and the canonical seed-of-record that every voice falls back
 * to. A `voiceView(snap, voiceSlug)` flattens the full snapshot to one voice's
 * resolvable `template_id -> row` map — the voice's own row wins, otherwise the
 * `__shared__` row. Includes resolve *within that view* so a voice's agent
 * prompt pulls in that voice's own partials (falling back to the shared partial
 * when the voice has not customised it), keeping assembled prompts byte-identical
 * to the pre-per-voice behaviour for a voice whose rows match `__shared__`.
 *
 * Module-level cache: one `Map` per isolate, keyed by `(voice_slug,
 * template_id)`. Workflow steps may run in fresh isolates, so callers always
 * pass `sql` and the function lazy-loads if empty. Call `invalidate()` after
 * editor writes to bust the cache.
 */

import type { Sql } from "postgres";
import type { PromptTemplateRow } from "../db/schema";

// ---------------------------------------------------------------------------
// Re-export the DB row type so callers can import from one place.
// ---------------------------------------------------------------------------
export type { PromptTemplateRow };

// ---------------------------------------------------------------------------
// Reserved sentinel voice for global / seed-of-record rows (judges + canonical
// agent/partial set). Mirrors the migration default and Python's SHARED_VOICE.
// ---------------------------------------------------------------------------
export const SHARED_VOICE = "__shared__";

// ---------------------------------------------------------------------------
// Module-level cache (per-isolate, lazy-loaded), keyed by `(voice_slug, id)`.
// ---------------------------------------------------------------------------
let _cache: Map<string, PromptTemplateRow> | null = null;

/** Composite cache key — `voice_slug` and `template_id` joined by `::`. Neither
 * a persona slug (`[a-z0-9-]+` / `__shared__`) nor a template_id
 * (`[A-Za-z0-9_./-]+`) contains a colon, so the pair is unambiguous. The key is
 * only used to de-dupe rows in the cache; `voiceView` reads row values, not keys. */
function cacheKey(voiceSlug: string, templateId: string): string {
  return `${voiceSlug}::${templateId}`;
}

// ---------------------------------------------------------------------------
// Include regex — matches `{{include:NAME}}` where NAME is [A-Za-z0-9_./-]+
// ---------------------------------------------------------------------------
const INCLUDE_RE = /\{\{include:([A-Za-z0-9_./-]+)\}\}/g;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------
export class PromptTemplateNotFound extends Error {
  readonly templateId: string;

  constructor(templateId: string) {
    super(`prompt template not found: ${templateId}`);
    this.name = "PromptTemplateNotFound";
    this.templateId = templateId;
  }
}

// ---------------------------------------------------------------------------
// Internal: load all rows from DB into a Map.
// ---------------------------------------------------------------------------
async function loadAll(sql: Sql): Promise<Map<string, PromptTemplateRow>> {
  const rows = await sql<PromptTemplateRow[]>`
    SELECT * FROM content_tool.prompt_templates
  `;
  const map = new Map<string, PromptTemplateRow>();
  for (const row of rows) {
    map.set(cacheKey(row.voice_slug, row.template_id), row);
  }
  return map;
}

// ---------------------------------------------------------------------------
// snapshot: return cached Map (keyed by `(voice_slug, id)`), loading from DB if
// empty. Treat the returned Map as read-only — use `voiceView` to project it
// onto one voice's resolvable `template_id -> row` map.
// ---------------------------------------------------------------------------
export async function snapshot(sql: Sql): Promise<Map<string, PromptTemplateRow>> {
  if (_cache === null) {
    _cache = await loadAll(sql);
  }
  return _cache;
}

// ---------------------------------------------------------------------------
// voiceView: flatten the `(voice, id)`-keyed snapshot to one voice's
// `template_id -> row` map. The voice's own row wins; otherwise the `__shared__`
// row (judges + canonical seed). Mirrors Python `prompts.py::_voice_view` and
// the runtime `_lookup_row` fallback chain. The resolved row's `voice_slug`
// reveals whether it is voice-owned or a shared fallback.
// ---------------------------------------------------------------------------
export function voiceView(
  snap: Map<string, PromptTemplateRow>,
  voiceSlug: string,
): Map<string, PromptTemplateRow> {
  const view = new Map<string, PromptTemplateRow>();
  for (const row of snap.values()) {
    if (row.voice_slug !== voiceSlug && row.voice_slug !== SHARED_VOICE) continue;
    const existing = view.get(row.template_id);
    // Voice-owned always beats the shared fallback, regardless of iteration order.
    if (existing === undefined || row.voice_slug === voiceSlug) {
      view.set(row.template_id, row);
    }
  }
  return view;
}

// ---------------------------------------------------------------------------
// invalidate: clear the cache (called after editor saves).
// ---------------------------------------------------------------------------
export function invalidate(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// resolveBody: inline all {{include:NAME}} directives recursively.
//
// - Each included partial's body is right-trimmed of trailing newlines before
//   inlining (`.replace(/\n+$/, "")`).
// - The TOP-LEVEL body's trailing newline is preserved — only trim INSIDE the
//   replace callback (i.e. on the partial's body, not the outer body).
// - Cycle detection via `seen` set → throws Error("prompt include cycle: …").
// - Unknown include name → throws PromptTemplateNotFound.
// ---------------------------------------------------------------------------
export function resolveBody(
  body: string,
  snap: Map<string, PromptTemplateRow>,
  seen: Set<string> = new Set(),
): string {
  return body.replace(INCLUDE_RE, (_match: string, name: string): string => {
    if (seen.has(name)) {
      throw new Error(`prompt include cycle: ${name}`);
    }
    const row = snap.get(name);
    if (row === undefined) {
      throw new PromptTemplateNotFound(name);
    }
    // Strip trailing newlines from the partial body before inlining.
    const partialBody = row.body.replace(/\n+$/, "");
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    return resolveBody(partialBody, snap, nextSeen);
  });
}

// ---------------------------------------------------------------------------
// resolveBodyWithOverrides: same as resolveBody but consults `overrides` at
// every `{{include:NAME}}` — when NAME is in the map, its draft body is slotted
// in place of the DB/stored row (used by the editor preview to reflect multiple
// unsaved partial drafts at once). An override body's own includes still resolve
// recursively, themselves honouring the override map.
// ---------------------------------------------------------------------------
export function resolveBodyWithOverrides(
  body: string,
  snap: Map<string, PromptTemplateRow>,
  overrides: ReadonlyMap<string, string>,
  seen: Set<string> = new Set(),
): string {
  return body.replace(INCLUDE_RE, (_match: string, name: string): string => {
    if (seen.has(name)) {
      throw new Error(`prompt include cycle: ${name}`);
    }
    const override = overrides.get(name);
    const inner =
      override !== undefined
        ? override.replace(/\n+$/, "")
        : (() => {
            const row = snap.get(name);
            if (row === undefined) throw new PromptTemplateNotFound(name);
            return row.body.replace(/\n+$/, "");
          })();
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    return resolveBodyWithOverrides(inner, snap, overrides, nextSeen);
  });
}

// ---------------------------------------------------------------------------
// Public API — mirrors Python names.
// ---------------------------------------------------------------------------

/**
 * Fully-resolved body for `(voiceSlug, templateId)` (all includes inlined).
 * Includes resolve within `voiceSlug`, falling back to `__shared__` per row.
 */
export async function getAssembled(
  sql: Sql,
  templateId: string,
  voiceSlug: string = SHARED_VOICE,
): Promise<string> {
  return assembleFromSnapshot(templateId, voiceView(await snapshot(sql), voiceSlug));
}

/**
 * Resolve `templateId`'s full body (with includes) from a pre-loaded snapshot.
 */
export function assembleFromSnapshot(
  templateId: string,
  snap: Map<string, PromptTemplateRow>,
): string {
  const row = snap.get(templateId);
  if (row === undefined) {
    throw new PromptTemplateNotFound(templateId);
  }
  return resolveBody(row.body, snap);
}

/**
 * Assemble `routeId` resolving each `{{include:NAME}}` against `overrides` (a
 * `partial_id -> draft_body` map) before falling back to the snapshot. Used by
 * the editor preview so multiple unsaved partial drafts are slotted into their
 * positions at once without a DB write. An empty map is byte-identical to
 * `assembleFromSnapshot(routeId, snap)`.
 */
export function assembleWithOverrides(
  routeId: string,
  snap: Map<string, PromptTemplateRow>,
  overrides: ReadonlyMap<string, string>,
): string {
  const row = snap.get(routeId);
  if (row === undefined) {
    throw new PromptTemplateNotFound(routeId);
  }
  return resolveBodyWithOverrides(row.body, snap, overrides);
}

/**
 * Assemble `routeId` but resolve `overrideName` to `overrideBody`.
 * Back-compat shim — delegates to {@link assembleWithOverrides} with a
 * single-entry map. Existing callers (the editor preview's partial path) are
 * untouched.
 */
export function assembleWithOverride(
  routeId: string,
  snap: Map<string, PromptTemplateRow>,
  opts: { overrideName: string; overrideBody: string },
): string {
  return assembleWithOverrides(routeId, snap, new Map([[opts.overrideName, opts.overrideBody]]));
}

/**
 * Placeholder substitution — replace `{key}` with `value` for each entry in
 * `vars`. Leaves unknown `{placeholders}` intact (matching Python behaviour).
 * Placeholder syntax: `{lower_snake}` (regex: /\{([a-z][a-z0-9_]*)\}/).
 */
export function substitute(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}
