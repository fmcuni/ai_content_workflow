import type { Sql } from "postgres";

// Cache TTL for resolved URLs — mirrors the Python `UrlResolver(ttl_days=7)`.
const TTL_INTERVAL = "7 days";

export interface UrlCacheRow {
  vertex_uri: string;
  final_url: string | null;
  domain: string | null;
  resolved_at: string;
  expires_at: string;
  error: string | null;
}

export interface UpsertCacheInput {
  vertexUri: string;
  finalUrl: string | null;
  domain: string | null;
  error: string | null;
}

/**
 * Fetch a cached resolution for `vertexUri` only if it is still fresh
 * (`expires_at > now()`). Mirrors the Python cache lookup which returns the row
 * only when `row.expires_at > datetime.now(UTC)`. Returns null on miss/stale.
 */
export async function getCached(
  sql: Sql,
  vertexUri: string,
): Promise<UrlCacheRow | null> {
  const rows = await sql<UrlCacheRow[]>`
    SELECT vertex_uri, final_url, domain, resolved_at, expires_at, error
    FROM content_tool.url_resolution_cache
    WHERE vertex_uri = ${vertexUri}
      AND expires_at > now()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Insert or refresh the cache row for `vertexUri`. `resolved_at` and
 * `expires_at` are recomputed server-side on every write (now() / now()+7d),
 * matching the Python `on_conflict_do_update` set clause.
 */
export async function upsertCache(
  sql: Sql,
  input: UpsertCacheInput,
): Promise<void> {
  const { vertexUri, finalUrl, domain, error } = input;
  await sql`
    INSERT INTO content_tool.url_resolution_cache
      (vertex_uri, final_url, domain, resolved_at, expires_at, error)
    VALUES (
      ${vertexUri},
      ${finalUrl},
      ${domain},
      now(),
      now() + ${TTL_INTERVAL}::interval,
      ${error}
    )
    ON CONFLICT (vertex_uri) DO UPDATE SET
      final_url = EXCLUDED.final_url,
      domain = EXCLUDED.domain,
      resolved_at = now(),
      expires_at = now() + ${TTL_INTERVAL}::interval,
      error = EXCLUDED.error
  `;
}
