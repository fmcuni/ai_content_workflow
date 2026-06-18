import type { Env } from "../index";
import type { getSql } from "../db/client";
import type { PublishTargetRow } from "../db/schema";
import { getPublishTargetForVoice } from "../db/publish_targets";

// Supported publish-target kinds (mirrors the DB CHECK in
// 20260618000000_publish_targets_ghost.sql and Python wp_factory.py).
const SUPPORTED_KINDS = new Set(["wordpress", "ghost"]);

export interface ResolvedTarget {
  // Env-var prefix for the target's credentials, or null for the default.
  // NOT a secret — safe to persist as a Workflow step result.
  authRef: string | null;
  label: string;
  isDefault: boolean;
  // "wordpress" (default) or "ghost" — selects the publisher at publish time.
  kind: string;
}

/**
 * Turn a publish-target row (or null for an unassigned voice) into a resolved
 * target descriptor. Pure — no DB, no env. Throws for an archived or
 * unsupported-kind target.
 */
export function targetFromRow(
  row: PublishTargetRow | null,
  defaultLabel: string,
): ResolvedTarget {
  if (row === null) {
    return { authRef: null, label: defaultLabel, isDefault: true, kind: "wordpress" };
  }
  if (row.is_archived) {
    throw new Error(`publish target '${row.name}' is archived and cannot be used`);
  }
  if (!SUPPORTED_KINDS.has(row.kind)) {
    throw new Error(`unsupported publish target kind '${row.kind}'`);
  }
  return { authRef: row.auth_ref, label: row.name, isDefault: false, kind: row.kind };
}

/**
 * Resolve the publish target for a voice. NULL/unknown voice → the default
 * (legacy WP env). Returns only non-secret descriptors, so the result is safe
 * to persist as a durable Workflow step result.
 */
export async function resolvePublishTarget(
  sql: ReturnType<typeof getSql>,
  personaSlug: string,
  defaultLabel: string,
): Promise<ResolvedTarget> {
  const row = await getPublishTargetForVoice(sql, personaSlug);
  return targetFromRow(row, defaultLabel);
}

/**
 * Build an Env whose WP_* credentials point at the resolved target, reading them
 * from the process env under the target's auth_ref prefix
 * ({ref}_BASE_URL / _USERNAME / _APP_PASSWORD). The default target returns env
 * unchanged. Credentials are read here (in the running Worker), never persisted.
 * Throws when a required credential env var is absent.
 */
export function buildTargetEnv(env: Env, target: ResolvedTarget): Env {
  // Ghost targets carry no WP_* creds; the GhostPublisher reads its own
  // ({ref}_API_URL / {ref}_ADMIN_API_KEY) via buildGhostCreds at publish time.
  if (target.isDefault || target.authRef === null || target.kind !== "wordpress") {
    return env;
  }
  const ref = target.authRef;
  const get = (key: string): string => {
    const value = (env as unknown as Record<string, string | undefined>)[key];
    if (!value) {
      throw new Error(`publish target requires env var ${key}, which is not set`);
    }
    return value;
  };
  return {
    ...env,
    WP_BASE_URL: get(`${ref}_BASE_URL`),
    WP_USERNAME: get(`${ref}_USERNAME`),
    WP_APP_PASSWORD: get(`${ref}_APP_PASSWORD`),
  };
}
