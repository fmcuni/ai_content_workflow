import type { PersonaRow } from "./schema";
import type { getSql } from "./client";
import { pgTimestampToIso, toJsonb } from "./serialize";

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

// All columns SELECTed/RETURNed by the mutation helpers — kept identical to the
// read helpers so every code path emits the same PersonaRecord shape.
const PERSONA_COLUMNS = [
  "persona_id",
  "slug",
  "name",
  "voice_rules",
  "banned_terms",
  "required_phrasings",
  "disclaimer_templates",
  "tone_examples",
  "glossary",
  "is_archived",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const;

// Shape accepted by createPersona — mirrors the Python `PersonaIn` model. The
// jsonb fields arrive already parsed from the request body.
export interface CreatePersonaInput {
  slug: string;
  name: string;
  voice_rules: string[];
  banned_terms: string[];
  required_phrasings: string[];
  disclaimer_templates: Record<string, { condition: string; disclaimer: string }>;
  tone_examples: Record<string, string[]>;
  glossary: unknown[];
}

// Partial patch accepted by updatePersona — mirrors the Python `PersonaPatch`
// model (every field optional; omitted fields preserve the stored value).
export interface UpdatePersonaInput {
  name?: string;
  voice_rules?: string[];
  banned_terms?: string[];
  required_phrasings?: string[];
  disclaimer_templates?: Record<string, { condition: string; disclaimer: string }>;
  tone_examples?: Record<string, string[]>;
  glossary?: unknown[];
}

/** Postgres unique-violation SQLSTATE — raised when a duplicate slug is inserted. */
export const PG_UNIQUE_VIOLATION = "23505";

/**
 * Insert a new persona. Mirrors the Python `create_persona` policy function.
 * jsonb columns are written via `toJsonb` so they store native arrays/objects
 * (never double-encoded strings). A duplicate slug raises a postgres error with
 * `code === PG_UNIQUE_VIOLATION`, which the route layer maps to HTTP 409.
 */
export async function createPersona(
  sql: ReturnType<typeof getSql>,
  input: CreatePersonaInput,
): Promise<PersonaRecord> {
  const rows = await sql<PersonaRow[]>`
    INSERT INTO content_tool.personas (
      slug, name, voice_rules, banned_terms, required_phrasings,
      disclaimer_templates, tone_examples, glossary
    ) VALUES (
      ${input.slug},
      ${input.name},
      ${toJsonb(sql, input.voice_rules)},
      ${toJsonb(sql, input.banned_terms)},
      ${toJsonb(sql, input.required_phrasings)},
      ${toJsonb(sql, input.disclaimer_templates)},
      ${toJsonb(sql, input.tone_examples)},
      ${toJsonb(sql, input.glossary)}
    )
    RETURNING ${sql(PERSONA_COLUMNS as unknown as string[])}
  `;
  // INSERT ... RETURNING always yields exactly one row on success.
  return normaliseRow(rows[0]!);
}

/**
 * Apply a partial update to a persona by slug, returning the updated record or
 * `null` if the slug does not exist (the route maps null → HTTP 404, mirroring
 * the Python `LookupError`). Only the fields present in `patch` are changed;
 * omitted fields use COALESCE to preserve the stored value. `updated_at` is
 * always bumped to now().
 */
export async function updatePersona(
  sql: ReturnType<typeof getSql>,
  slug: string,
  patch: UpdatePersonaInput,
): Promise<PersonaRecord | null> {
  const rows = await sql<PersonaRow[]>`
    UPDATE content_tool.personas SET
      name = COALESCE(${patch.name ?? null}, name),
      voice_rules = COALESCE(${patch.voice_rules === undefined ? null : toJsonb(sql, patch.voice_rules)}, voice_rules),
      banned_terms = COALESCE(${patch.banned_terms === undefined ? null : toJsonb(sql, patch.banned_terms)}, banned_terms),
      required_phrasings = COALESCE(${patch.required_phrasings === undefined ? null : toJsonb(sql, patch.required_phrasings)}, required_phrasings),
      disclaimer_templates = COALESCE(${patch.disclaimer_templates === undefined ? null : toJsonb(sql, patch.disclaimer_templates)}, disclaimer_templates),
      tone_examples = COALESCE(${patch.tone_examples === undefined ? null : toJsonb(sql, patch.tone_examples)}, tone_examples),
      glossary = COALESCE(${patch.glossary === undefined ? null : toJsonb(sql, patch.glossary)}, glossary),
      updated_at = now()
    WHERE slug = ${slug}
    RETURNING ${sql(PERSONA_COLUMNS as unknown as string[])}
  `;
  const row = rows[0];
  return row !== undefined ? normaliseRow(row) : null;
}

/**
 * Set (or clear) the archived flag on a persona, mirroring the Python
 * `set_archived` helper. Returns the updated record, or `null` if the slug does
 * not exist (route maps null → HTTP 404).
 */
export async function setArchived(
  sql: ReturnType<typeof getSql>,
  slug: string,
  archived: boolean,
): Promise<PersonaRecord | null> {
  const rows = await sql<PersonaRow[]>`
    UPDATE content_tool.personas
    SET is_archived = ${archived}, updated_at = now()
    WHERE slug = ${slug}
    RETURNING ${sql(PERSONA_COLUMNS as unknown as string[])}
  `;
  const row = rows[0];
  return row !== undefined ? normaliseRow(row) : null;
}
