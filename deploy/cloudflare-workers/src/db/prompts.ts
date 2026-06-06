// Query helpers for content_tool.prompt_versions, scoped per voice.
// All tables are fully-qualified — no search_path is set on the connection.
//
// List/detail/schema/consumers/preview are served from the in-process snapshot
// + `voiceView` (see routes/prompts.ts) so they resolve a voice's templates the
// same way the runtime loader does. These helpers cover the version-history
// reads that hit content_tool.prompt_versions directly, scoped by
// `(voice_slug, template_id)` to mirror content_tool/api/routes/prompts.py.

import type postgres from "postgres";
import type { PromptTemplateRow } from "./schema";

type Sql = ReturnType<typeof postgres>;

// ---- constants -------------------------------------------------------------

/**
 * Categories the prompt editor surfaces and manages. Judges live in the same
 * table but are not editable, so history/version reads for a judge id 404.
 * Mirrors `_EDITABLE_CATEGORIES` in content_tool/api/routes/prompts.py.
 */
const EDITABLE_CATEGORIES = new Set<string>(["agent", "partial"]);

// ---- types -----------------------------------------------------------------

/** One history entry — mirrors the Python history item (no body, no voice). */
export interface VersionSummary {
  version_id: string;
  sha256: string;
  parent_sha256: string | null;
  bytes: number;
  saved_by: string;
  saved_at: string;
  kind: string;
}

/** Full version detail returned by the single-version endpoint (no voice). */
export interface VersionDetail {
  version_id: string;
  template_id: string;
  sha256: string;
  parent_sha256: string | null;
  body: string;
  bytes: number;
  saved_by: string;
  saved_at: string;
  kind: string;
}

// ---- helpers ---------------------------------------------------------------

/**
 * True when `(voice_slug, template_id)` resolves to an editable agent/partial
 * row for the requested voice — its own row, or the `__shared__` fallback.
 * Mirrors the route's `_editable_or_404(_voice_view(...), id)` gate.
 */
async function isEditableInVoice(
  sql: Sql,
  templateId: string,
  voiceSlug: string,
): Promise<boolean> {
  const rows = await sql<Pick<PromptTemplateRow, "category">[]>`
    SELECT category
    FROM content_tool.prompt_templates
    WHERE template_id = ${templateId}
      AND voice_slug IN (${voiceSlug}, '__shared__')
    LIMIT 1
  `;
  const row = rows[0];
  return row !== undefined && EDITABLE_CATEGORIES.has(row.category);
}

// ---- query functions -------------------------------------------------------

/**
 * Return version history for `(voice, template)`, newest-first, body omitted.
 * Returns `null` if the template does not resolve to an editable row for the
 * voice. `limit` is clamped to [1, 200] by the route layer before calling this.
 */
export async function getTemplateHistory(
  sql: Sql,
  templateId: string,
  voiceSlug: string,
  limit: number,
): Promise<VersionSummary[] | null> {
  if (!(await isEditableInVoice(sql, templateId, voiceSlug))) return null;

  const rows = await sql<VersionSummary[]>`
    SELECT version_id, sha256, parent_sha256, bytes, saved_by, saved_at, kind
    FROM content_tool.prompt_versions
    WHERE voice_slug = ${voiceSlug} AND template_id = ${templateId}
    ORDER BY saved_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

/**
 * Return a single version INCLUDING `body`, scoped to `(voice, template)`.
 * Returns `null` if the version does not exist for that voice/template, or the
 * template does not resolve to an editable row for the voice.
 */
export async function getVersion(
  sql: Sql,
  templateId: string,
  voiceSlug: string,
  versionId: string,
): Promise<VersionDetail | null> {
  if (!(await isEditableInVoice(sql, templateId, voiceSlug))) return null;

  const rows = await sql<VersionDetail[]>`
    SELECT version_id, template_id, sha256, parent_sha256, body, bytes, saved_by, saved_at, kind
    FROM content_tool.prompt_versions
    WHERE version_id = ${versionId}
      AND voice_slug = ${voiceSlug}
      AND template_id = ${templateId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
