import type { getSql } from "./client";
import type { PublishTargetRow } from "./schema";

const TARGET_COLUMNS = `
  publish_target_id, name, kind, auth_ref, status, is_archived
`;

/**
 * List CMS publish targets ordered by created_at ASC. Mirrors the Python
 * `GET /publish-targets`. Non-secret config only (credentials live in env).
 */
export async function listPublishTargets(
  sql: ReturnType<typeof getSql>,
  includeArchived: boolean,
): Promise<PublishTargetRow[]> {
  return includeArchived
    ? await sql<PublishTargetRow[]>`
        SELECT ${sql.unsafe(TARGET_COLUMNS)}
        FROM content_tool.publish_targets
        ORDER BY created_at ASC
      `
    : await sql<PublishTargetRow[]>`
        SELECT ${sql.unsafe(TARGET_COLUMNS)}
        FROM content_tool.publish_targets
        WHERE is_archived = false
        ORDER BY created_at ASC
      `;
}

/** Postgres unique-violation SQLSTATE — route layer maps it to HTTP 409. */
export const PG_UNIQUE_VIOLATION = "23505";

/** Fetch a single target by id, or null. */
export async function getPublishTarget(
  sql: ReturnType<typeof getSql>,
  targetId: string,
): Promise<PublishTargetRow | null> {
  const rows = await sql<PublishTargetRow[]>`
    SELECT ${sql.unsafe(TARGET_COLUMNS)}
    FROM content_tool.publish_targets
    WHERE publish_target_id = ${targetId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Whether an auth_ref is already used by any target (uniqueness pre-check). */
export async function authRefExists(
  sql: ReturnType<typeof getSql>,
  authRef: string,
): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM content_tool.publish_targets
    WHERE auth_ref = ${authRef} LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Insert a new WordPress target (Phase 2 self-service). Non-secret config only.
 * Relies on a route-level auth_ref uniqueness pre-check; a concurrent insert
 * surfaces as a PG_UNIQUE_VIOLATION the route maps to 409 only if a UNIQUE
 * constraint exists (none today — the pre-check is authoritative).
 */
export async function createPublishTarget(
  sql: ReturnType<typeof getSql>,
  input: { name: string; auth_ref: string; status: string },
): Promise<PublishTargetRow> {
  const rows = await sql<PublishTargetRow[]>`
    INSERT INTO content_tool.publish_targets (name, kind, auth_ref, status, is_archived)
    VALUES (${input.name}, 'wordpress', ${input.auth_ref}, ${input.status}, false)
    RETURNING ${sql.unsafe(TARGET_COLUMNS)}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("INSERT ... RETURNING produced no row");
  }
  return row;
}

/**
 * Patch a target's display name / status (auth_ref + kind are immutable).
 * Only provided fields change. Returns null when the id does not resolve.
 */
export async function updatePublishTarget(
  sql: ReturnType<typeof getSql>,
  targetId: string,
  patch: { name?: string; status?: string },
): Promise<PublishTargetRow | null> {
  const rows = await sql<PublishTargetRow[]>`
    UPDATE content_tool.publish_targets
    SET name   = COALESCE(${patch.name ?? null}, name),
        status = COALESCE(${patch.status ?? null}, status),
        updated_at = now()
    WHERE publish_target_id = ${targetId}
    RETURNING ${sql.unsafe(TARGET_COLUMNS)}
  `;
  return rows[0] ?? null;
}

/** Set is_archived. Returns null when the id does not resolve. */
export async function setTargetArchived(
  sql: ReturnType<typeof getSql>,
  targetId: string,
  archived: boolean,
): Promise<PublishTargetRow | null> {
  const rows = await sql<PublishTargetRow[]>`
    UPDATE content_tool.publish_targets
    SET is_archived = ${archived}, updated_at = now()
    WHERE publish_target_id = ${targetId}
    RETURNING ${sql.unsafe(TARGET_COLUMNS)}
  `;
  return rows[0] ?? null;
}

/** Count voices (personas) assigned to a target — used to warn before archive. */
export async function countVoicesForTarget(
  sql: ReturnType<typeof getSql>,
  targetId: string,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM content_tool.personas
    WHERE publish_target_id = ${targetId}
  `;
  return Number(rows[0]?.count ?? "0");
}

/**
 * Resolve the publish target a voice (persona) is assigned to, or null when the
 * voice is unknown or has no target (NULL FK → caller falls back to the legacy
 * WP env). Joins personas → publish_targets in one round trip.
 */
export async function getPublishTargetForVoice(
  sql: ReturnType<typeof getSql>,
  personaSlug: string,
): Promise<PublishTargetRow | null> {
  const rows = await sql<PublishTargetRow[]>`
    SELECT t.publish_target_id, t.name, t.kind, t.auth_ref, t.status, t.is_archived
    FROM content_tool.personas p
    JOIN content_tool.publish_targets t
      ON t.publish_target_id = p.publish_target_id
    WHERE p.slug = ${personaSlug}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
