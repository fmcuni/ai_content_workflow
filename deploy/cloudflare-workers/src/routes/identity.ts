/**
 * Session-derived actor identity for audit fields (`created_by`, `approved_by`).
 *
 * The backend Worker authenticates every REST request (src/auth/middleware.ts),
 * setting `userEmail` (cookie/session path) and/or `userId`. Audit fields MUST
 * be derived from that SESSION identity — never from a client-supplied payload
 * value, which a caller could spoof to attribute an action to someone else.
 *
 * Resolution order (first non-empty wins):
 *   1. session email   (`c.get("userEmail")`) — the compliance record-of-truth
 *   2. session user id  (`c.get("userId")`)    — SSE-ticket path carries only id
 *   3. payload email    (`editor_email`)        — dev / AUTH_DISABLED fallback
 *   4. "unknown"
 *
 * When ANY session identity (email or id) is present, the payload value is
 * IGNORED so a spoofed `editor_email` cannot override the authenticated actor.
 *
 * Parity note (Python backend, content_tool/api/routes/runs.py): the Python app
 * reads `editor_email` straight from the request body because it has no session
 * gate (auth is enforced by the Workers/Next layer in production). This Workers
 * port HARDENS that by binding identity to the verified session; the payload
 * fallback preserves byte-compatible behavior only on the AUTH_DISABLED dev path
 * where no session exists.
 */

interface SessionIdentity {
  userEmail?: string | undefined;
  userId?: string | undefined;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Resolve the audit actor identity. Pure so it can be unit-tested without an
 * HTTP + DB harness (mirrors run_guards.ts).
 */
export function resolveActorIdentity(
  session: SessionIdentity,
  payloadEmail: string | null | undefined,
): string {
  const sessionIdentity = firstNonEmpty(session.userEmail, session.userId);
  if (sessionIdentity !== null) {
    // A verified session is present — the payload value is untrusted and ignored.
    return sessionIdentity;
  }
  // No session (SSE-ticket without email already handled above; AUTH_DISABLED
  // dev path) → fall back to the payload, then a sentinel.
  return firstNonEmpty(payloadEmail) ?? "unknown";
}
