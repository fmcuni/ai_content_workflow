// Source-policy routes — TypeScript port of content_tool/api/routes/source_policy.py.
//
// Mounted at /source-policy in src/index.ts. Paths here are RELATIVE to that mount.
//
//   GET  /                     — live policy + rendered prompt block + sha256
//   POST /preview              — render the block from a candidate policy (no save)
//   PUT  /                     — save a structured edit (optimistic-concurrency, versioned)
//   GET  /history              — version history, newest-first, body omitted
//   GET  /versions/:versionId  — one version with its full policy
//   POST /revert               — restore a past version (versioned)

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { pgTimestampToIso } from "../db/serialize";
import {
  SourcePolicy,
  cleanPolicy,
  canonicalPolicyJson,
} from "../config/source_policy";
import { sha256Hex, utf8ByteLength } from "../prompts/editor";
import {
  snapshot,
  invalidate,
  fallbackSnapshot,
  POLICY_ID,
} from "../source_policy/store";
import type { SourcePolicyRow, SourcePolicyVersionRow } from "../db/schema";

const MAX_POLICY_BYTES = 64 * 1024;
const EXPECTED_SHA_LENGTH = 64;
const DEFAULT_HISTORY_LIMIT = 50;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 200;

const LIST_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["deny", "domains"],
  ["prefer", "tlds"],
  ["prefer", "domains"],
  ["community_exception", "topic_categories"],
  ["community_exception", "allowed_domains"],
];

export const sourcePolicyRouter = new Hono<{ Bindings: Env }>();

/** Mirror of Python `_require_editor` dev-mode default (see prompts.ts). */
function resolveEditor(c: Context<{ Bindings: Env }>): string {
  const email = (c.req.header("X-Editor-Email") ?? "").trim().toLowerCase();
  return email.length > 0 ? email : "dev@local";
}

/**
 * Validate a candidate policy object. Returns an error message for a malformed
 * section/field, or null when well-formed. Mirrors Python `_validate_policy`.
 */
function validatePolicy(policy: Record<string, unknown>): string | null {
  for (const sectionKey of ["deny", "prefer", "community_exception"]) {
    const section = policy[sectionKey];
    if (
      section !== undefined &&
      (section === null || typeof section !== "object" || Array.isArray(section))
    ) {
      return `'${sectionKey}' must be an object`;
    }
  }
  for (const [sectionKey, fieldKey] of LIST_FIELDS) {
    const section = policy[sectionKey];
    if (section === null || typeof section !== "object") continue;
    const value = (section as Record<string, unknown>)[fieldKey];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      return `'${sectionKey}.${fieldKey}' must be an array of strings`;
    }
  }
  return null;
}

function snapshotPayload(snap: {
  policyId: string;
  raw: unknown;
  sha256: string;
  bytes: number;
}): Record<string, unknown> {
  return {
    policy_id: snap.policyId,
    policy: snap.raw,
    sha256: snap.sha256,
    bytes: snap.bytes,
    rendered: new SourcePolicy(snap.raw).toPromptBlock(),
  };
}

// ---------------------------------------------------------------------------
// GET / — live policy
// ---------------------------------------------------------------------------
sourcePolicyRouter.get("/", async (c) => {
  const snap = await withDb(c.env, c.executionCtx, (sql) => snapshot(sql));
  return c.json(snapshotPayload(snap));
});

// ---------------------------------------------------------------------------
// POST /preview — render the block from a candidate policy without saving.
// ---------------------------------------------------------------------------
sourcePolicyRouter.post("/preview", async (c) => {
  const body = await c.req.json<{ policy?: unknown }>().catch(() => null);
  if (body === null || body.policy === null || typeof body.policy !== "object") {
    return c.json({ detail: "policy is required" }, 422);
  }
  const policy = body.policy as Record<string, unknown>;
  const err = validatePolicy(policy);
  if (err !== null) {
    return c.json({ detail: { error: "invalid_policy", message: err } }, 400);
  }
  const cleaned = cleanPolicy(policy);
  return c.json({ policy: cleaned, rendered: new SourcePolicy(cleaned).toPromptBlock() });
});

// ---------------------------------------------------------------------------
// PUT / — save a structured edit (optimistic concurrency, versioned).
// ---------------------------------------------------------------------------
type SaveResult =
  | { kind: "ok"; savedAt: string | null }
  | { kind: "stale"; currentSha: string };

sourcePolicyRouter.put("/", async (c) => {
  const editor = resolveEditor(c);
  const body = await c.req
    .json<{ policy?: unknown; expected_sha256?: unknown }>()
    .catch(() => null);
  if (
    body === null ||
    body.policy === null ||
    typeof body.policy !== "object" ||
    typeof body.expected_sha256 !== "string"
  ) {
    return c.json({ detail: "policy and expected_sha256 are required" }, 422);
  }
  if (body.expected_sha256.length !== EXPECTED_SHA_LENGTH) {
    return c.json({ detail: "expected_sha256 must be 64 hex characters" }, 422);
  }
  const policy = body.policy as Record<string, unknown>;
  const validationError = validatePolicy(policy);
  if (validationError !== null) {
    return c.json({ detail: { error: "invalid_policy", message: validationError } }, 400);
  }

  const cleaned = cleanPolicy(policy);
  const newBody = canonicalPolicyJson(policy);
  const newBytes = utf8ByteLength(newBody);
  if (newBytes > MAX_POLICY_BYTES) {
    return c.json({ detail: `policy exceeds ${MAX_POLICY_BYTES} bytes (got ${newBytes})` }, 413);
  }
  const newSha = await sha256Hex(newBody);
  const expectedSha = body.expected_sha256;
  const versionId = crypto.randomUUID();
  const fallbackSha = (await fallbackSnapshot()).sha256;

  const result = await withDb(c.env, c.executionCtx, (sql) =>
    sql.begin(async (tx): Promise<SaveResult> => {
      const rows = await tx<Pick<SourcePolicyRow, "sha256">[]>`
        SELECT sha256 FROM content_tool.source_policy
        WHERE policy_id = ${POLICY_ID}
        FOR UPDATE
      `;
      const row = rows[0];
      const currentSha = row !== undefined ? row.sha256 : fallbackSha;
      if (currentSha !== expectedSha) {
        return { kind: "stale", currentSha };
      }
      const parentSha = row !== undefined ? row.sha256 : null;

      await tx`
        INSERT INTO content_tool.source_policy
          (policy_id, body, sha256, bytes, updated_by, updated_at)
        VALUES (${POLICY_ID}, ${newBody}, ${newSha}, ${newBytes}, ${editor}, now())
        ON CONFLICT (policy_id) DO UPDATE SET
          body = ${newBody}, sha256 = ${newSha}, bytes = ${newBytes},
          updated_by = ${editor}, updated_at = now()
      `;
      const ins = await tx<{ saved_at: string }[]>`
        INSERT INTO content_tool.source_policy_versions
          (version_id, policy_id, sha256, parent_sha256, body, bytes, saved_by, kind)
        VALUES
          (${versionId}, ${POLICY_ID}, ${newSha}, ${parentSha}, ${newBody}, ${newBytes}, ${editor}, 'save')
        RETURNING saved_at
      `;
      return { kind: "ok", savedAt: ins[0]?.saved_at ?? null };
    }),
  );

  if (result.kind === "stale") {
    return c.json(
      {
        detail: {
          error: "stale_sha",
          message: "source policy was changed since you loaded it",
          current_sha256: result.currentSha,
        },
      },
      409,
    );
  }
  invalidate();
  return c.json({
    policy_id: POLICY_ID,
    policy: cleaned,
    sha256: newSha,
    bytes: newBytes,
    rendered: new SourcePolicy(cleaned).toPromptBlock(),
    version_id: versionId,
    saved_at: pgTimestampToIso(result.savedAt),
    saved_by: editor,
  });
});

// ---------------------------------------------------------------------------
// GET /history?limit=50
// ---------------------------------------------------------------------------
sourcePolicyRouter.get("/history", async (c) => {
  const rawLimit = c.req.query("limit");
  let limit = DEFAULT_HISTORY_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = parseInt(rawLimit, 10);
    if (!Number.isInteger(parsed) || parsed < MIN_HISTORY_LIMIT || parsed > MAX_HISTORY_LIMIT) {
      return c.json(
        { detail: `limit must be an integer between ${MIN_HISTORY_LIMIT} and ${MAX_HISTORY_LIMIT}` },
        422,
      );
    }
    limit = parsed;
  }
  const versions = await withDb(c.env, c.executionCtx, async (sql) => {
    const rows = await sql<Omit<SourcePolicyVersionRow, "body">[]>`
      SELECT version_id, policy_id, sha256, parent_sha256, bytes, saved_by, saved_at, kind
      FROM content_tool.source_policy_versions
      WHERE policy_id = ${POLICY_ID}
      ORDER BY saved_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      version_id: r.version_id,
      sha256: r.sha256,
      parent_sha256: r.parent_sha256,
      bytes: r.bytes,
      saved_by: r.saved_by,
      saved_at: pgTimestampToIso(r.saved_at),
      kind: r.kind,
    }));
  });
  return c.json({ policy_id: POLICY_ID, versions });
});

// ---------------------------------------------------------------------------
// GET /versions/:versionId
// ---------------------------------------------------------------------------
sourcePolicyRouter.get("/versions/:versionId", async (c) => {
  const versionId = c.req.param("versionId");
  const row = await withDb(c.env, c.executionCtx, async (sql) => {
    const rows = await sql<SourcePolicyVersionRow[]>`
      SELECT version_id, policy_id, sha256, parent_sha256, body, bytes, saved_by, saved_at, kind
      FROM content_tool.source_policy_versions
      WHERE version_id = ${versionId} AND policy_id = ${POLICY_ID}
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
  if (row === null) {
    return c.json({ detail: `unknown version_id '${versionId}'` }, 404);
  }
  const cleaned = cleanPolicy(JSON.parse(row.body));
  return c.json({
    version_id: row.version_id,
    policy_id: row.policy_id,
    sha256: row.sha256,
    parent_sha256: row.parent_sha256,
    policy: cleaned,
    rendered: new SourcePolicy(cleaned).toPromptBlock(),
    bytes: row.bytes,
    saved_by: row.saved_by,
    saved_at: pgTimestampToIso(row.saved_at),
    kind: row.kind,
  });
});

// ---------------------------------------------------------------------------
// POST /revert — restore a past version (versioned, same concurrency gate).
// ---------------------------------------------------------------------------
type RevertResult =
  | { kind: "ok"; savedAt: string | null; newSha: string; newBytes: number; body: string }
  | { kind: "not_found" }
  | { kind: "stale"; currentSha: string }
  | { kind: "unknown_version" };

sourcePolicyRouter.post("/revert", async (c) => {
  const editor = resolveEditor(c);
  const body = await c.req
    .json<{ target_version_id?: unknown; expected_sha256?: unknown }>()
    .catch(() => null);
  if (
    body === null ||
    typeof body.target_version_id !== "string" ||
    typeof body.expected_sha256 !== "string" ||
    body.expected_sha256.length !== EXPECTED_SHA_LENGTH
  ) {
    return c.json(
      { detail: "target_version_id and a 64-char expected_sha256 are required" },
      422,
    );
  }
  const targetVersionId = body.target_version_id;
  const expectedSha = body.expected_sha256;
  const versionId = crypto.randomUUID();

  const result = await withDb(c.env, c.executionCtx, (sql) =>
    sql.begin(async (tx): Promise<RevertResult> => {
      const rows = await tx<Pick<SourcePolicyRow, "sha256">[]>`
        SELECT sha256 FROM content_tool.source_policy
        WHERE policy_id = ${POLICY_ID}
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined) {
        return { kind: "not_found" };
      }
      const currentSha = row.sha256;
      if (currentSha !== expectedSha) {
        return { kind: "stale", currentSha };
      }
      const targetRows = await tx<{ body: string }[]>`
        SELECT body FROM content_tool.source_policy_versions
        WHERE version_id = ${targetVersionId} AND policy_id = ${POLICY_ID}
        LIMIT 1
      `;
      const target = targetRows[0];
      if (target === undefined) {
        return { kind: "unknown_version" };
      }
      const newBody = target.body;
      const newBytes = utf8ByteLength(newBody);
      const newSha = await sha256Hex(newBody);
      await tx`
        UPDATE content_tool.source_policy
        SET body = ${newBody}, sha256 = ${newSha}, bytes = ${newBytes},
            updated_by = ${editor}, updated_at = now()
        WHERE policy_id = ${POLICY_ID}
      `;
      const ins = await tx<{ saved_at: string }[]>`
        INSERT INTO content_tool.source_policy_versions
          (version_id, policy_id, sha256, parent_sha256, body, bytes, saved_by, kind)
        VALUES
          (${versionId}, ${POLICY_ID}, ${newSha}, ${currentSha}, ${newBody}, ${newBytes}, ${editor}, 'revert')
        RETURNING saved_at
      `;
      return { kind: "ok", savedAt: ins[0]?.saved_at ?? null, newSha, newBytes, body: newBody };
    }),
  );

  switch (result.kind) {
    case "not_found":
      return c.json({ detail: "source policy not initialised" }, 404);
    case "stale":
      return c.json(
        {
          detail: {
            error: "stale_sha",
            message: "source policy was changed since you loaded it",
            current_sha256: result.currentSha,
          },
        },
        409,
      );
    case "unknown_version":
      return c.json({ detail: `unknown version_id '${targetVersionId}'` }, 404);
    case "ok": {
      invalidate();
      const cleaned = cleanPolicy(JSON.parse(result.body));
      return c.json({
        policy_id: POLICY_ID,
        policy: cleaned,
        sha256: result.newSha,
        bytes: result.newBytes,
        rendered: new SourcePolicy(cleaned).toPromptBlock(),
        version_id: versionId,
        saved_at: pgTimestampToIso(result.savedAt),
        saved_by: editor,
        reverted_from_version_id: targetVersionId,
      });
    }
  }
});

export default sourcePolicyRouter;
