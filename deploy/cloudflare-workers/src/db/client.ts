import postgres from "postgres";
import type { Env } from "../index";

// Server-side ceiling (ms) on any single query. A stalled Hyperdrive→Supabase
// socket would otherwise hang `await sql\`...\`` indefinitely — in a Workflow
// step that means stalling until the 10-minute default step timeout (the
// resolve_citations bug behind prod run a6e897e1). Postgres aborts the query
// instead, so the await rejects fast and the caller (or step retry) recovers.
// 30s is far above any real OLTP query in this app; it only catches hangs.
const STATEMENT_TIMEOUT_MS = 30_000;

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
    // Sent as a startup parameter so every pooled connection inherits the
    // per-query ceiling (see STATEMENT_TIMEOUT_MS). Hyperdrive may not forward
    // it on every path, so fan-out callers also cap themselves at the step level
    // (CITATIONS_STEP_CONFIG) — this is the cleaner root-cause layer.
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
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
