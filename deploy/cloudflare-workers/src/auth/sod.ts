/**
 * Segregation of duties (4-eyes) for run approval / publishing.
 *
 * The author of a run must not be the person who approves (HITL_2 approve) or
 * publishes (republish) it. We compare the run's `created_by` to the acting
 * session identity case-insensitively.
 *
 * Break-glass: an `admin` (effective role) may override the bar by supplying a
 * non-empty `override_reason`; the override is recorded by the caller (audit
 * log + response flag), per the locked RBAC contract.
 *
 * Pure + side-effect-free so it can be unit-tested without an HTTP/DB harness
 * (mirrors run_guards.ts / identity.ts).
 */
import type { Role } from "./authz";

export interface SodInput {
  /** The run's author identity (`runs.created_by`). */
  createdBy: string | null | undefined;
  /** The acting session identity (resolved email, else userId). */
  actor: string | null | undefined;
  /** The actor's effective role. */
  actorRole: Role;
  /** Optional break-glass reason from the request body. */
  overrideReason?: string | null | undefined;
}

export type SodVerdict =
  | { allowed: true; override: false }
  | { allowed: true; override: true; reason: string }
  | { allowed: false };

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Decide whether the actor may approve/publish the run.
 *
 * - Author ≠ actor → allowed, no override.
 * - Author == actor:
 *     - admin + non-empty override_reason → allowed WITH override (break-glass).
 *     - otherwise → forbidden (self-approval).
 *
 * An unknown/blank author or actor never trips the bar (cannot prove they are
 * the same person); this matches the dev/AUTH_DISABLED "unknown" fallback in
 * ./identity, where 4-eyes cannot be meaningfully enforced.
 */
export function evaluateSod(input: SodInput): SodVerdict {
  const author = norm(input.createdBy);
  const actor = norm(input.actor);

  const isSelf = author.length > 0 && actor.length > 0 && author === actor;
  if (!isSelf) {
    return { allowed: true, override: false };
  }

  const reason = (input.overrideReason ?? "").trim();
  if (input.actorRole === "admin" && reason.length > 0) {
    return { allowed: true, override: true, reason };
  }
  return { allowed: false };
}
