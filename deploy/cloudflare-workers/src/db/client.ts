import postgres from "postgres";
import type { Env } from "../index";

// Mirrors the proven `/db/ping` pattern in src/index.ts: connect through
// Hyperdrive (no upstream TLS handshake on the hot path → no free-plan
// subrequest blowup), and `fetch_types: false` trims pg_catalog round-trips.
//
// NOTE: no `search_path` is configured on purpose — every query in this
// codebase fully-qualifies tables with the `content_tool.` schema prefix.
export function getSql(env: Env): ReturnType<typeof postgres> {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    // Keep date/timestamp columns as the RAW Postgres text (not JS `Date`) so
    // downstream formatting stays microsecond-faithful — `Date.toISOString()`
    // truncates to milliseconds and would break parity with Python's
    // datetime.isoformat() output. JSON/JSONB parsing is left untouched.
    types: {
      date: {
        to: 1184,
        from: [1082, 1083, 1114, 1184], // date, time, timestamp, timestamptz
        serialize: (v: string): string => v,
        parse: (v: string): string => v,
      },
    },
  });
}

// Opens a short-lived sql connection, runs `fn`, and closes the socket after
// the response is sent (via `ctx.waitUntil`), mirroring how `/db/ping` cleans
// up. Errors from `sql.end()` are swallowed so cleanup never masks the result.
export async function withDb<T>(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  fn: (sql: ReturnType<typeof getSql>) => Promise<T>,
): Promise<T> {
  const sql = getSql(env);
  try {
    return await fn(sql);
  } finally {
    ctx.waitUntil(sql.end().catch(() => undefined));
  }
}
