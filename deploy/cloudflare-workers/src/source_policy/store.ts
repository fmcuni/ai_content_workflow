/**
 * DB-backed source-policy store — TypeScript port of
 * `content_tool/source_policy_store.py` for Cloudflare Workers.
 *
 * Loads the singleton `content_tool.source_policy` row ('default'), parses its
 * canonical-JSON body into a `SourcePolicy`, and caches per-isolate. The writer
 * prompt assembly + citation evaluation + editor preview all read from here, so
 * an edit reaches the runtime without a redeploy. Falls back to the bundled
 * `SOURCE_POLICY_RAW` when the row is absent (migration not pushed yet).
 *
 * Per-isolate cache (Workflow steps may run in fresh isolates), so callers
 * always pass `sql` and the function lazy-loads if empty. `invalidate()` busts
 * the cache after an editor write.
 */

import type { Sql } from "postgres";
import {
  SourcePolicy,
  SOURCE_POLICY_RAW,
  cleanPolicy,
  canonicalPolicyJson,
  type CleanPolicy,
} from "../config/source_policy";
import { sha256Hex, utf8ByteLength } from "../util/hash";
import type { SourcePolicyRow } from "../db/schema";

export const POLICY_ID = "default";

export interface PolicySnapshot {
  policyId: string;
  raw: CleanPolicy;
  body: string;
  sha256: string;
  bytes: number;
}

let _cache: PolicySnapshot | null = null;

/** Snapshot built from the bundled constant when the DB row is absent. */
export async function fallbackSnapshot(): Promise<PolicySnapshot> {
  const raw = cleanPolicy(SOURCE_POLICY_RAW);
  const body = canonicalPolicyJson(SOURCE_POLICY_RAW);
  return {
    policyId: POLICY_ID,
    raw,
    body,
    sha256: await sha256Hex(body),
    bytes: utf8ByteLength(body),
  };
}

async function loadSnapshot(sql: Sql): Promise<PolicySnapshot> {
  const rows = await sql<Pick<SourcePolicyRow, "policy_id" | "body" | "sha256" | "bytes">[]>`
    SELECT policy_id, body, sha256, bytes
    FROM content_tool.source_policy
    WHERE policy_id = ${POLICY_ID}
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) {
    return fallbackSnapshot();
  }
  return {
    policyId: row.policy_id,
    raw: cleanPolicy(JSON.parse(row.body)),
    body: row.body,
    sha256: row.sha256,
    bytes: row.bytes,
  };
}

/** The live policy snapshot, loading + caching on first use. */
export async function snapshot(sql: Sql): Promise<PolicySnapshot> {
  if (_cache === null) {
    _cache = await loadSnapshot(sql);
  }
  return _cache;
}

export function invalidate(): void {
  _cache = null;
}

/** The live `SourcePolicy` instance (for prompt block + citation evaluation). */
export async function getPolicy(sql: Sql): Promise<SourcePolicy> {
  return new SourcePolicy((await snapshot(sql)).raw);
}
