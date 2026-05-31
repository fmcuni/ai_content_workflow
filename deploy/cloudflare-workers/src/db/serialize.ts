import type { Parameter, Sql } from "postgres";

// Shared timestamp serialization helpers for parity with the Python backend.
//
// postgres.js is configured (in `getSql`) to return date/timestamp columns as
// the RAW Postgres text it received over the wire — e.g.
// "2026-05-26 04:12:15.007466+00" — instead of a JS `Date`. We deliberately
// avoid `Date` because `Date.toISOString()` truncates to milliseconds, whereas
// Python's `datetime.isoformat()` emits 6-digit microseconds. We must match the
// captured baselines byte-for-byte: "2026-05-26T04:12:15.007466Z".

/**
 * Convert a raw Postgres timestamptz text value into the ISO-8601 form Python
 * emits: space→`T` separator and a trailing `+00`/`+00:00` offset rewritten to
 * `Z`. Returns `null` for `null` input.
 *
 * Defensive: if a value somehow arrives as a `Date` (e.g. a future config
 * change re-enables Date parsing), fall back to the Date's ISO string so this
 * can never throw a `.replace is not a function` TypeError again.
 */
export function pgTimestampToIso(raw: string | null): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  // Defensive runtime narrowing: the declared contract is `string`, but treat
  // the value as `unknown` so a stray `Date` (or other type) can never throw.
  const value: unknown = raw;

  if (value instanceof Date) {
    // Fallback only: millisecond precision, but never throws.
    return value.toISOString();
  }

  if (typeof value !== "string") {
    // Last-resort coercion for any unexpected runtime value.
    return String(value);
  }

  // Replace the space separator with T, then normalise a trailing timezone
  // offset (+00, +00:00, -00, -00:00) to Z.
  return value.replace(" ", "T").replace(/[+-]00(:00)?$/, "Z");
}

/**
 * Normalise a jsonb column value read back from Postgres into its native JS
 * shape (array/object). postgres.js already parses native jsonb into JS values,
 * but legacy rows written with the old `${JSON.stringify(value)}::jsonb` idiom
 * stored a jsonb STRING SCALAR — those read back as a JSON string and must be
 * parsed once more. This guard is idempotent: native values pass straight
 * through, strings are JSON-parsed, and `null`/`undefined` are preserved.
 */
/**
 * Build a NATIVE jsonb bind parameter for a WRITE.
 *
 * postgres.js `sql.json(value)` tags the value with the jsonb OID (3802) and
 * serializes it exactly once, so the column stores a native jsonb array/object
 * — identical to how Python/SQLAlchemy and the SQL seed write jsonb. This
 * REPLACES the buggy `${JSON.stringify(value)}::jsonb` idiom, which passed a
 * pre-serialized STRING that the `::jsonb` cast then stored as a string scalar
 * (double-encoded), breaking native-array/object reads for both backends.
 *
 * The `JSONValue` parameter type postgres.js declares is structurally stricter
 * than interface-typed app values (it requires index signatures), so we accept
 * `unknown` and narrow at this single boundary. Runtime behaviour is unchanged.
 */
export function toJsonb(sql: Sql, value: unknown): Parameter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sql.json(value as Parameters<Sql["json"]>[0]);
}

export function pgJson<T>(value: unknown): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      // Not valid JSON — return as-is rather than throwing on edge data.
      return value as T;
    }
  }
  return value as T;
}
