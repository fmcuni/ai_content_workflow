/**
 * DB-backed source-policy store — TypeScript port of
 * `content_tool/source_policy_store.py` for Cloudflare Workers.
 *
 * Loads one `content_tool.source_policy` row PER VOICE (PK `voice_slug`), parses
 * its canonical-JSON body into a `SourcePolicy`, and caches per-isolate keyed by
 * the requested voice. The writer prompt assembly + citation evaluation + editor
 * preview all read from here, so an edit reaches the runtime without a redeploy.
 *
 * Per-voice resolution follows a strict fallback chain so a voice created before
 * a policy row existed (or any read during the deploy window) still resolves and
 * the app keeps booting:
 *
 *     voice_slug  ->  '__shared__'  ->  bundled SOURCE_POLICY_RAW
 *
 * The reserved sentinel `__shared__` holds the seed-of-record. The canonical
 * serializer matches Python byte-for-byte, so the `sha256` optimistic-concurrency
 * token and the rendered prompt block stay in parity across both backends.
 *
 * Per-isolate cache (Workflow steps may run in fresh isolates), so callers always
 * pass `sql` and the function lazy-loads if empty. `invalidate()` busts the cache
 * after an editor write.
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

// Reserved sentinel voice for the global / seed-of-record policy row. Mirrors
// the migration default and Python's SHARED_VOICE.
export const SHARED_VOICE = "__shared__";

// Retained only as the `policy_id` *history label* written into
// source_policy_versions (the live source_policy table no longer has a
// policy_id column — PK is voice_slug). Kept exported so the route module that
// still references it does not break.
export const POLICY_ID = "default";

export interface PolicySnapshot {
  voiceSlug: string;
  raw: CleanPolicy;
  body: string;
  sha256: string;
  bytes: number;
}

// Per-voice cache, keyed by the requested voice_slug (a voice that fell back to
// the shared row is cached under its own key so the next read is still one hop).
let _cache: Map<string, PolicySnapshot> | null = null;

/** Snapshot built from the bundled constant when no DB row resolves. */
export async function fallbackSnapshot(
  voiceSlug: string = SHARED_VOICE,
): Promise<PolicySnapshot> {
  const raw = cleanPolicy(SOURCE_POLICY_RAW);
  const body = canonicalPolicyJson(SOURCE_POLICY_RAW);
  return {
    voiceSlug,
    raw,
    body,
    sha256: await sha256Hex(body),
    bytes: utf8ByteLength(body),
  };
}

/** Load exactly one voice's policy row, or `null` if it has none. */
async function loadOne(sql: Sql, voiceSlug: string): Promise<PolicySnapshot | null> {
  const rows = await sql<Pick<SourcePolicyRow, "voice_slug" | "body" | "sha256" | "bytes">[]>`
    SELECT voice_slug, body, sha256, bytes
    FROM content_tool.source_policy
    WHERE voice_slug = ${voiceSlug}
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    voiceSlug: row.voice_slug,
    raw: cleanPolicy(JSON.parse(row.body)),
    body: row.body,
    sha256: row.sha256,
    bytes: row.bytes,
  };
}

/** Resolve a voice's policy via `voice -> __shared__ -> bundled constant`. */
async function resolve(sql: Sql, voiceSlug: string): Promise<PolicySnapshot> {
  let snap = await loadOne(sql, voiceSlug);
  if (snap === null && voiceSlug !== SHARED_VOICE) {
    snap = await loadOne(sql, SHARED_VOICE);
  }
  return snap ?? (await fallbackSnapshot(voiceSlug));
}

/** The voice's policy snapshot, loading + caching on first use. */
export async function snapshot(
  sql: Sql,
  voiceSlug: string = SHARED_VOICE,
): Promise<PolicySnapshot> {
  if (_cache === null) _cache = new Map();
  let snap = _cache.get(voiceSlug);
  if (snap === undefined) {
    snap = await resolve(sql, voiceSlug);
    _cache.set(voiceSlug, snap);
  }
  return snap;
}

export function invalidate(): void {
  _cache = null;
}

/** The live `SourcePolicy` for `voiceSlug` (prompt block + citation evaluation). */
export async function getPolicy(
  sql: Sql,
  voiceSlug: string = SHARED_VOICE,
): Promise<SourcePolicy> {
  return new SourcePolicy((await snapshot(sql, voiceSlug)).raw);
}
