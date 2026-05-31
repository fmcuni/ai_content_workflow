// Query helpers for content_tool.prompt_templates and content_tool.prompt_versions.
// All tables are fully-qualified — no search_path is set on the connection.

import type postgres from "postgres";
import type { PromptTemplateRow, PromptVersionRow } from "./schema";

type Sql = ReturnType<typeof postgres>;

// ---- types -----------------------------------------------------------------

/** Columns returned by the list-templates endpoint (no `body`). */
export interface TemplateListItem {
  template_id: string;
  filename: string;
  category: string;
  sha256: string;
  bytes: number;
}

/** Full template detail returned by the single-template endpoint. */
export interface TemplateDetail {
  template_id: string;
  filename: string;
  category: string;
  /** Raw template body (includes `{{include:…}}` directives). */
  template: string;
  sha256: string;
}

/** One history entry — same as PromptVersionRow but `body` is omitted. */
export type VersionSummary = Omit<PromptVersionRow, "body">;

// ---- constants -------------------------------------------------------------

/**
 * Categories the prompt editor surfaces and manages.
 * Judge / eval templates live in the same table but are NOT editable,
 * so they are excluded from all list/detail responses.
 * Mirrors `_EDITABLE_CATEGORIES` in content_tool/api/routes/prompts.py.
 */
const EDITABLE_CATEGORIES = new Set<string>(["agent", "partial"]);

// ---- helpers ---------------------------------------------------------------

function isEditable(row: Pick<PromptTemplateRow, "category">): boolean {
  return EDITABLE_CATEGORIES.has(row.category);
}

/**
 * Sort comparator that replicates the Python route's ordering:
 *   items.sort(key=lambda i: (i["category"] == "partial", i["template_id"]))
 *
 * Agent templates sort before partials; within each group, alphabetical by
 * template_id.
 */
function compareTemplateListItems(a: TemplateListItem, b: TemplateListItem): number {
  const aIsPartial = a.category === "partial" ? 1 : 0;
  const bIsPartial = b.category === "partial" ? 1 : 0;
  if (aIsPartial !== bIsPartial) return aIsPartial - bIsPartial;
  return a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0;
}

// ---- query functions -------------------------------------------------------

/**
 * Return all editable templates (agent + partial categories), sorted:
 * agents first (alphabetical), then partials (alphabetical).
 * Does NOT return the `body` column.
 */
export async function listTemplates(sql: Sql): Promise<TemplateListItem[]> {
  const rows = await sql<PromptTemplateRow[]>`
    SELECT template_id, filename, category, sha256, bytes
    FROM content_tool.prompt_templates
    ORDER BY template_id
  `;
  const items: TemplateListItem[] = rows
    .filter(isEditable)
    .map(({ template_id, filename, category, sha256, bytes }) => ({
      template_id,
      filename,
      category,
      sha256,
      bytes,
    }));
  items.sort(compareTemplateListItems);
  return items;
}

/**
 * Return the full detail for one template (includes `body` as `template`).
 * Returns `null` if the template does not exist or is not in an editable category.
 */
export async function getTemplate(
  sql: Sql,
  templateId: string,
): Promise<TemplateDetail | null> {
  const rows = await sql<PromptTemplateRow[]>`
    SELECT template_id, filename, category, body, sha256
    FROM content_tool.prompt_templates
    WHERE template_id = ${templateId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || !isEditable(row)) return null;
  return {
    template_id: row.template_id,
    filename: row.filename,
    category: row.category,
    template: row.body,
    sha256: row.sha256,
  };
}

/**
 * Return version history for a template, newest-first, with `body` omitted.
 * Returns `null` if the template does not exist or is not editable.
 * `limit` is clamped to [1, 200] by the route layer before calling this.
 */
export async function getTemplateHistory(
  sql: Sql,
  templateId: string,
  limit: number,
): Promise<VersionSummary[] | null> {
  // Verify the template exists and is editable first.
  const tmplRows = await sql<Pick<PromptTemplateRow, "template_id" | "category">[]>`
    SELECT template_id, category
    FROM content_tool.prompt_templates
    WHERE template_id = ${templateId}
    LIMIT 1
  `;
  const tmpl = tmplRows[0];
  if (!tmpl || !isEditable(tmpl)) return null;

  const rows = await sql<VersionSummary[]>`
    SELECT version_id, template_id, sha256, parent_sha256, bytes, saved_by, saved_at, kind
    FROM content_tool.prompt_versions
    WHERE template_id = ${templateId}
    ORDER BY saved_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

/**
 * Return a single version INCLUDING `body`.
 * Returns `null` if the version does not exist, belongs to a different template,
 * or the parent template is not editable.
 */
export async function getVersion(
  sql: Sql,
  templateId: string,
  versionId: string,
): Promise<PromptVersionRow | null> {
  // Verify template is editable.
  const tmplRows = await sql<Pick<PromptTemplateRow, "template_id" | "category">[]>`
    SELECT template_id, category
    FROM content_tool.prompt_templates
    WHERE template_id = ${templateId}
    LIMIT 1
  `;
  const tmpl = tmplRows[0];
  if (!tmpl || !isEditable(tmpl)) return null;

  const rows = await sql<PromptVersionRow[]>`
    SELECT version_id, template_id, sha256, parent_sha256, body, bytes, saved_by, saved_at, kind
    FROM content_tool.prompt_versions
    WHERE version_id = ${versionId}
      AND template_id = ${templateId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
