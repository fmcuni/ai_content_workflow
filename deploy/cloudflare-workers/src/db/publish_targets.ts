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
