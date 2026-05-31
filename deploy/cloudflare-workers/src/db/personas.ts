import type { PersonaRow } from "./schema";
import type { getSql } from "./client";
import { pgTimestampToIso } from "./serialize";

// Shape returned to callers — timestamps are already normalised to ISO strings.
export interface PersonaRecord {
  persona_id: string;
  slug: string;
  name: string;
  voice_rules: unknown;
  banned_terms: unknown;
  required_phrasings: unknown;
  disclaimer_templates: unknown;
  tone_examples: unknown;
  glossary: unknown;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

function normaliseRow(row: PersonaRow): PersonaRecord {
  return {
    persona_id: row.persona_id,
    slug: row.slug,
    name: row.name,
    voice_rules: row.voice_rules,
    banned_terms: row.banned_terms,
    required_phrasings: row.required_phrasings,
    disclaimer_templates: row.disclaimer_templates,
    tone_examples: row.tone_examples,
    glossary: row.glossary,
    is_archived: row.is_archived,
    // created_at / updated_at are NOT NULL columns, so the helper never
    // returns null here; assert to keep the non-nullable record shape.
    created_at: pgTimestampToIso(row.created_at)!,
    updated_at: pgTimestampToIso(row.updated_at)!,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

/**
 * Return all personas ordered by created_at ASC, mirroring the Python
 * list_personas policy function.
 *
 * @param includeArchived - when false (default) rows with is_archived = true
 *   are excluded, matching the Python `include_archived=False` default.
 */
export async function listPersonas(
  sql: ReturnType<typeof getSql>,
  includeArchived: boolean,
): Promise<PersonaRecord[]> {
  const rows = includeArchived
    ? await sql<PersonaRow[]>`
        SELECT
          persona_id, slug, name,
          voice_rules, banned_terms, required_phrasings,
          disclaimer_templates, tone_examples, glossary,
          is_archived, created_at, updated_at, created_by, updated_by
        FROM content_tool.personas
        ORDER BY created_at ASC
      `
    : await sql<PersonaRow[]>`
        SELECT
          persona_id, slug, name,
          voice_rules, banned_terms, required_phrasings,
          disclaimer_templates, tone_examples, glossary,
          is_archived, created_at, updated_at, created_by, updated_by
        FROM content_tool.personas
        WHERE is_archived = false
        ORDER BY created_at ASC
      `;

  return rows.map(normaliseRow);
}

// Shape returned by GET /personas/:slug/usage — mirrors the Python
// `PersonaUsage` model (slug, by_status map, total).
export interface PersonaUsage {
  slug: string;
  by_status: Record<string, number>;
  total: number;
}

interface StatusCountRow {
  // COUNT() arrives as a STRING under `fetch_types: false`; coerce to number.
  status: string;
  n: string | number;
}

/**
 * Return per-status run counts for a persona, mirroring the Python
 * `/personas/{slug}/usage` aggregation:
 *
 *   SELECT status, COUNT(*) FROM runs WHERE persona = :slug GROUP BY status
 *
 * `total` is the sum of all per-status counts. COUNT() comes back as a STRING
 * under `fetch_types: false`, so every count is coerced through Number() before
 * arithmetic — never string-concatenated.
 */
export async function getPersonaUsage(
  sql: ReturnType<typeof getSql>,
  slug: string,
): Promise<PersonaUsage> {
  const rows = await sql<StatusCountRow[]>`
    SELECT status, COUNT(*) AS n
    FROM content_tool.runs
    WHERE persona = ${slug}
    GROUP BY status
  `;

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const count = typeof row.n === "string" ? Number(row.n) : row.n;
    byStatus[row.status] = count;
    total += count;
  }

  return { slug, by_status: byStatus, total };
}

/**
 * Return a single persona by slug, or null if not found.
 */
export async function getPersonaBySlug(
  sql: ReturnType<typeof getSql>,
  slug: string,
): Promise<PersonaRecord | null> {
  const rows = await sql<PersonaRow[]>`
    SELECT
      persona_id, slug, name,
      voice_rules, banned_terms, required_phrasings,
      disclaimer_templates, tone_examples, glossary,
      is_archived, created_at, updated_at, created_by, updated_by
    FROM content_tool.personas
    WHERE slug = ${slug}
    LIMIT 1
  `;

  const row = rows[0];
  return row !== undefined ? normaliseRow(row) : null;
}
