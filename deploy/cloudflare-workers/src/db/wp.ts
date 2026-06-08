import type postgres from "postgres";

// Shared shape returned by both /wp-options/users and /wp-options/categories.
export interface WpOptionItem {
  id: number;
  name: string;
  slug: string;
}

const Q_MAX_LEN = 100;

/**
 * Query wp_users for a single publish target with optional filter.
 *
 * `authRef` scopes the lookup to one CMS instance's cached snapshot (the
 * publish_targets env-prefix, e.g. 'WP' or 'VHIS101_WP'). Filter logic (mirrors
 * the Python parity baseline):
 *   - No q (or empty)   → all rows for authRef, ordered name ASC.
 *   - q is all-digits   → id = q::int  (exact match).
 *   - Otherwise         → name ILIKE '%' || q || '%', ordered name ASC.
 *
 * q is clamped to Q_MAX_LEN characters before use.
 */
export async function queryWpUsers(
  sql: ReturnType<typeof postgres>,
  rawQ: string | undefined,
  authRef: string,
): Promise<WpOptionItem[]> {
  const q = (rawQ ?? "").slice(0, Q_MAX_LEN);

  if (q === "") {
    const rows = await sql<WpOptionItem[]>`
      SELECT id, name, slug
      FROM content_tool.wp_users
      WHERE auth_ref = ${authRef}
      ORDER BY name ASC
    `;
    return rows;
  }

  if (/^\d+$/.test(q)) {
    const id = parseInt(q, 10);
    const rows = await sql<WpOptionItem[]>`
      SELECT id, name, slug
      FROM content_tool.wp_users
      WHERE auth_ref = ${authRef} AND id = ${id}
      ORDER BY name ASC
    `;
    return rows;
  }

  const rows = await sql<WpOptionItem[]>`
    SELECT id, name, slug
    FROM content_tool.wp_users
    WHERE auth_ref = ${authRef} AND name ILIKE ${"%" + q + "%"}
    ORDER BY name ASC
  `;
  return rows;
}

/**
 * Query wp_categories for a single publish target with optional filter.
 *
 * `authRef` scopes the lookup to one CMS instance's cached snapshot. Filter
 * logic is identical to queryWpUsers (id match for all-digit q, ILIKE name
 * match otherwise).
 */
export async function queryWpCategories(
  sql: ReturnType<typeof postgres>,
  rawQ: string | undefined,
  authRef: string,
): Promise<WpOptionItem[]> {
  const q = (rawQ ?? "").slice(0, Q_MAX_LEN);

  if (q === "") {
    const rows = await sql<WpOptionItem[]>`
      SELECT id, name, slug
      FROM content_tool.wp_categories
      WHERE auth_ref = ${authRef}
      ORDER BY name ASC
    `;
    return rows;
  }

  if (/^\d+$/.test(q)) {
    const id = parseInt(q, 10);
    const rows = await sql<WpOptionItem[]>`
      SELECT id, name, slug
      FROM content_tool.wp_categories
      WHERE auth_ref = ${authRef} AND id = ${id}
      ORDER BY name ASC
    `;
    return rows;
  }

  const rows = await sql<WpOptionItem[]>`
    SELECT id, name, slug
    FROM content_tool.wp_categories
    WHERE auth_ref = ${authRef} AND name ILIKE ${"%" + q + "%"}
    ORDER BY name ASC
  `;
  return rows;
}
