import type { PersonaRow, PromptTemplateRow, SourcePolicyRow } from "./schema";
import type { getSql } from "./client";
import { pgTimestampToIso, toJsonb } from "./serialize";
import { POLICY_ID, SHARED_VOICE } from "../source_policy/store";

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

/** Number of non-archived personas (voices). Mirrors `count_active_personas`. */
export async function countActivePersonas(
  sql: ReturnType<typeof getSql>,
): Promise<number> {
  const rows = await sql<{ n: string | number }[]>`
    SELECT COUNT(*) AS n
    FROM content_tool.personas
    WHERE is_archived = false
  `;
  const n = rows[0]?.n ?? 0;
  return typeof n === "string" ? Number(n) : n;
}

/** Discriminated result of a duplicate attempt — mirrors the Python route's
 * LookupError (404) / DuplicateSlugError (409) / success (201) branches. */
export type DuplicateResult =
  | { kind: "ok"; record: PersonaRecord }
  | { kind: "source_not_found" }
  | { kind: "dup_slug" };

/**
 * Deep-copy a voice into `newSlug`: the persona row + the source voice's
 * resolved agent/partial prompt templates (source voice wins over `__shared__`)
 * + its source policy, seeding initial prompt_versions / source_policy_versions
 * rows — all in one transaction. Mirrors
 * `content_tool/policy/personas.py::duplicate_persona`.
 *
 * Cloned prompt/policy bodies are byte-identical to the source's resolved set,
 * so the new voice starts with the same assembled prompts (and sha256 tokens).
 */
export async function duplicatePersona(
  sql: ReturnType<typeof getSql>,
  sourceSlug: string,
  newSlug: string,
  newName: string,
): Promise<DuplicateResult> {
  // No created_by is threaded from the route (matches Python: created_by=None);
  // version rows are stamped with a synthetic actor.
  const actor = "system:duplicate";

  return sql.begin(async (tx): Promise<DuplicateResult> => {
    const srcRows = await tx<PersonaRow[]>`
      SELECT
        persona_id, slug, name,
        voice_rules, banned_terms, required_phrasings,
        disclaimer_templates, tone_examples, glossary,
        is_archived, created_at, updated_at, created_by, updated_by
      FROM content_tool.personas
      WHERE slug = ${sourceSlug}
      LIMIT 1
    `;
    const src = srcRows[0];
    if (src === undefined) return { kind: "source_not_found" };

    const existing = await tx<{ slug: string }[]>`
      SELECT slug FROM content_tool.personas WHERE slug = ${newSlug} LIMIT 1
    `;
    if (existing[0] !== undefined) return { kind: "dup_slug" };

    // 1. Clone the persona row (fresh jsonb containers, never aliasing source).
    const cloneRows = await tx<PersonaRow[]>`
      INSERT INTO content_tool.personas (
        slug, name, voice_rules, banned_terms, required_phrasings,
        disclaimer_templates, tone_examples, glossary
      ) VALUES (
        ${newSlug},
        ${newName},
        ${toJsonb(sql, src.voice_rules)},
        ${toJsonb(sql, src.banned_terms)},
        ${toJsonb(sql, src.required_phrasings)},
        ${toJsonb(sql, src.disclaimer_templates)},
        ${toJsonb(sql, src.tone_examples)},
        ${toJsonb(sql, src.glossary ?? [])}
      )
      RETURNING ${tx(PERSONA_COLUMNS as unknown as string[])}
    `;

    // 2. Resolve the source voice's agent/partial set: its own row wins, the
    //    `__shared__` seed fills any gap (the runtime fallback chain). Judges
    //    stay global (`__shared__`) and are never copied per voice.
    const templateRows = await tx<PromptTemplateRow[]>`
      SELECT voice_slug, template_id, category, filename, body, sha256, bytes
      FROM content_tool.prompt_templates
      WHERE voice_slug IN (${SHARED_VOICE}, ${sourceSlug})
        AND category IN ('agent', 'partial')
    `;
    const resolved = new Map<string, PromptTemplateRow>();
    for (const r of templateRows) {
      const winner = resolved.get(r.template_id);
      if (winner === undefined || r.voice_slug === sourceSlug) {
        resolved.set(r.template_id, r);
      }
    }
    for (const r of resolved.values()) {
      await tx`
        INSERT INTO content_tool.prompt_templates
          (voice_slug, template_id, category, filename, body, sha256, bytes, updated_by)
        VALUES
          (${newSlug}, ${r.template_id}, ${r.category}, ${r.filename}, ${r.body}, ${r.sha256}, ${r.bytes}, ${null})
      `;
      await tx`
        INSERT INTO content_tool.prompt_versions
          (version_id, voice_slug, template_id, sha256, parent_sha256, body, bytes, saved_by, kind)
        VALUES
          (${crypto.randomUUID()}, ${newSlug}, ${r.template_id}, ${r.sha256}, ${null}, ${r.body}, ${r.bytes}, ${actor}, 'save')
      `;
    }

    // 3. Resolve + clone the source voice's source policy (its own row wins).
    const policyRows = await tx<SourcePolicyRow[]>`
      SELECT voice_slug, body, sha256, bytes
      FROM content_tool.source_policy
      WHERE voice_slug IN (${SHARED_VOICE}, ${sourceSlug})
    `;
    let policy: SourcePolicyRow | undefined;
    for (const r of policyRows) {
      if (policy === undefined || r.voice_slug === sourceSlug) policy = r;
    }
    if (policy !== undefined) {
      await tx`
        INSERT INTO content_tool.source_policy
          (voice_slug, body, sha256, bytes, updated_by)
        VALUES
          (${newSlug}, ${policy.body}, ${policy.sha256}, ${policy.bytes}, ${null})
      `;
      await tx`
        INSERT INTO content_tool.source_policy_versions
          (version_id, voice_slug, policy_id, sha256, parent_sha256, body, bytes, saved_by, kind)
        VALUES
          (${crypto.randomUUID()}, ${newSlug}, ${POLICY_ID}, ${policy.sha256}, ${null}, ${policy.body}, ${policy.bytes}, ${actor}, 'save')
      `;
    }

    return { kind: "ok", record: normaliseRow(cloneRows[0]!) };
  });
}
