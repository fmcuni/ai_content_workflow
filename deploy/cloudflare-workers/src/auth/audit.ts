/**
 * Minimal structured audit logger for security-relevant RBAC events.
 *
 * The Workers backend has no logging library — Cloudflare ingests anything
 * written to `console` and surfaces it in Workers Logs / tail. We emit a single
 * JSON line per event so it is greppable and machine-parseable. This is the
 * record-of-truth for events that have no dedicated DB column (e.g. the SoD
 * break-glass override and role changes), per the locked RBAC contract.
 *
 * NOTE: this app handles public editorial content only — no PII/PHI/HKID flows
 * through these events. Identities here are staff emails / user ids, which are
 * already the audit record-of-truth elsewhere in this backend.
 */

export type AuditEvent =
  | "rbac.sod_override"
  | "rbac.role_change"
  | "rbac.role_change_blocked";

/** Emit one structured JSON audit line. Pure side-effect; never throws. */
export function auditLog(event: AuditEvent, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- Workers' only logging sink.
  console.log(JSON.stringify({ audit: event, ts: new Date().toISOString(), ...fields }));
}
