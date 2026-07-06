import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import type { Env } from "../index";

// Server-side ceiling (ms) on any single query. A stalled Hyperdrive→Supabase
// socket would otherwise hang `await sql\`...\`` indefinitely — in a Workflow
// step that means stalling until the 10-minute default step timeout (the
// resolve_citations bug behind prod run a6e897e1). Postgres aborts the query
// instead, so the await rejects fast and the caller (or step retry) recovers.
// 30s is far above any real OLTP query in this app; it only catches hangs.
const STATEMENT_TIMEOUT_MS = 30_000;

// ponytail: per-REQUEST client cache (NOT per-isolate). A cross-request
// module-scope cache was tried and PROVED unsafe on Workers: reusing a
// postgres.js socket opened under one request from a later request throws
// "Cannot perform I/O on behalf of a different request" — confirmed live
// (alternating 500s). AsyncLocalStorage scopes the cache to the single
// request that's currently executing (see runWithSqlContext in src/index.ts),
// so the CPU win (skip re-parsing the connection string / rebuilding the
// type-parser tables) is kept for the 2-3 getSql() calls typically made
// within ONE request (auth's loadRole + the route handler + wp-options
// retries), without ever handing a socket across requests.
const sqlContext = new AsyncLocalStorage<Map<string, ReturnType<typeof postgres>>>();

function buildSql(connectionString: string): ReturnType<typeof postgres> {
  return postgres(connectionString, {
    max: 5,
    fetch_types: false,
    // Sockets are never explicitly `.end()`ed by request-scoped callers
    // anymore (there's no single place left holding the "close" responsibility
    // once the client is request-scoped instead of a long-lived isolate
    // singleton) — bound their lifetime here instead so they self-close rather
    // than lingering until isolate eviction. Hyperdrive owns the real
    // connection to Postgres; this only governs the Worker-side postgres.js
    // handle.
    idle_timeout: 5,
    max_lifetime: 300,
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

// Runs `fn` with a fresh, empty per-request client cache in scope. Call this
// ONCE per incoming request (src/index.ts wraps the whole Hono app in it).
// Code that runs outside any request (Workflow steps, DO alarms) never enters
// this store, so getSql() below falls back to building a fresh client per
// call there — unchanged from pre-cache behavior.
export function runWithSqlContext<T>(fn: () => T): T {
  return sqlContext.run(new Map(), fn);
}

// Mirrors the proven `/db/ping` pattern in src/index.ts: connect through
// Hyperdrive (no upstream TLS handshake on the hot path → no free-plan
// subrequest blowup), and `fetch_types: false` trims pg_catalog round-trips.
//
// NOTE: no `search_path` is configured on purpose — every query in this
// codebase fully-qualifies tables with the `content_tool.` schema prefix.
export function getSql(env: Env): ReturnType<typeof postgres> {
  const connectionString = env.HYPERDRIVE.connectionString;
  const store = sqlContext.getStore();
  if (!store) {
    // No request in scope (Workflow / DO alarm) — always a fresh client;
    // the caller owns its lifecycle (see withSql() in the workflows).
    return buildSql(connectionString);
  }
  const cached = store.get(connectionString);
  if (cached) return cached;
  const sql = buildSql(connectionString);
  store.set(connectionString, sql);
  return sql;
}

// Self-heal escape hatch: if a request-scoped client turns out to be dead
// (e.g. a connection-flavored error mid-request, see isConnectionError
// below), evict it from the current request's cache so the NEXT getSql()
// call in this same request rebuilds a fresh one instead of erroring
// forever. Outside a request context this is a no-op — there is no store to
// evict from, and callers there own a single client per call anyway.
export function resetSqlCache(connectionString?: string): void {
  const store = sqlContext.getStore();
  if (!store) return;
  if (connectionString) {
    store.delete(connectionString);
  } else {
    store.clear();
  }
}

// Shared heuristic for "this error means the socket/cached client is dead,
// not that the query was bad" — narrow on purpose so a routine SQL error
// (bad input, constraint violation) doesn't pointlessly evict a healthy
// shared client. Used by every caller that shares the getSql() cache and
// wants to self-heal after a connection-flavored failure.
//
// Message match covers the Workers-specific cross-request fault
// ("Cannot perform I/O on behalf of a different request") plus generic
// Node/socket errors. `.code` match covers postgres.js's own connection
// errors (node_modules/postgres/cjs/src/errors.js `connection()`), which are
// thrown as `new Error("write " + code + " host:port")` with `err.code` set
// to the literal — e.g. CONNECTION_CLOSED, CONNECTION_DESTROYED,
// CONNECTION_ENDED, CONNECT_TIMEOUT. Those messages do NOT contain
// "Connection terminated", so they'd be missed by a message-only regex.
const CONNECTION_ERROR_RE = /different request|Cannot perform I\/O|ECONNRESET|Connection terminated/i;
const CONNECTION_ERROR_CODE_RE = /^(CONN|ECONN)/;

export function isConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (CONNECTION_ERROR_RE.test(message)) return true;
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && CONNECTION_ERROR_CODE_RE.test(code);
}

// Runs `fn` against the request-scoped cached client (or a fresh one outside
// a request). Named `withDb` (not `withSql`) to match existing call sites; no
// longer opens/closes a short-lived connection per call inside a request —
// see getSql() above for how request scoping keeps that safe.
export async function withDb<T>(
  env: Env,
  _ctx: { waitUntil: (p: Promise<unknown>) => void },
  fn: (sql: ReturnType<typeof getSql>) => Promise<T>,
): Promise<T> {
  const sql = getSql(env);
  return fn(sql);
}
