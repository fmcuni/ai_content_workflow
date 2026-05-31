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
 * Module-level cache: one `Map` per isolate. Workflow steps may run in fresh
 * isolates, so callers always pass `sql` and the function lazy-loads if empty.
 * Call `invalidate()` after editor writes to bust the cache.
 */

import type { Sql } from "postgres";
import type { PromptTemplateRow } from "../db/schema";

// ---------------------------------------------------------------------------
// Re-export the DB row type so callers can import from one place.
// ---------------------------------------------------------------------------
export type { PromptTemplateRow };

// ---------------------------------------------------------------------------
// Module-level cache (per-isolate, lazy-loaded).
// ---------------------------------------------------------------------------
let _cache: Map<string, PromptTemplateRow> | null = null;

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
    map.set(row.template_id, row);
  }
  return map;
}

// ---------------------------------------------------------------------------
// snapshot: return cached Map, loading from DB if empty.
// ---------------------------------------------------------------------------
export async function snapshot(sql: Sql): Promise<Map<string, PromptTemplateRow>> {
  if (_cache === null) {
    _cache = await loadAll(sql);
  }
  return _cache;
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
// resolveBodyWithOverride: same as resolveBody but slots an unsaved draft
// partial in place of `overrideName` (used by the editor preview).
// ---------------------------------------------------------------------------
function resolveBodyWithOverride(
  body: string,
  snap: Map<string, PromptTemplateRow>,
  overrideName: string,
  overrideBody: string,
  seen: Set<string> = new Set(),
): string {
  return body.replace(INCLUDE_RE, (_match: string, name: string): string => {
    if (seen.has(name)) {
      throw new Error(`prompt include cycle: ${name}`);
    }
    const inner =
      name === overrideName
        ? overrideBody.replace(/\n+$/, "")
        : (() => {
            const row = snap.get(name);
            if (row === undefined) throw new PromptTemplateNotFound(name);
            return row.body.replace(/\n+$/, "");
          })();
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    return resolveBodyWithOverride(inner, snap, overrideName, overrideBody, nextSeen);
  });
}

// ---------------------------------------------------------------------------
// Public API — mirrors Python names.
// ---------------------------------------------------------------------------

/**
 * Raw, unresolved body for `templateId` (no include expansion).
 * Throws PromptTemplateNotFound if missing.
 */
export async function getBody(sql: Sql, templateId: string): Promise<string> {
  const snap = await snapshot(sql);
  const row = snap.get(templateId);
  if (row === undefined) {
    throw new PromptTemplateNotFound(templateId);
  }
  return row.body;
}

/**
 * Fully-resolved body for `templateId` (all includes inlined).
 */
export async function getAssembled(sql: Sql, templateId: string): Promise<string> {
  return assembleFromSnapshot(templateId, await snapshot(sql));
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
 * Assemble `routeId` but resolve `overrideName` to `overrideBody`.
 * Used by the editor preview so an unsaved partial draft is slotted into its
 * position without a DB write.
 */
export function assembleWithOverride(
  routeId: string,
  snap: Map<string, PromptTemplateRow>,
  opts: { overrideName: string; overrideBody: string },
): string {
  const row = snap.get(routeId);
  if (row === undefined) {
    throw new PromptTemplateNotFound(routeId);
  }
  return resolveBodyWithOverride(row.body, snap, opts.overrideName, opts.overrideBody);
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
