/**
 * Pure guards for run mutation routes — kept separate from the Hono handlers so
 * the 404 / 409 contract can be unit-tested without an HTTP + DB harness.
 */

export type RestartGuard =
  | { ok: true }
  | { error: "not_found" | "not_failed" };

/**
 * Decide whether a run may be restarted.
 *
 * Only `failed` runs are restartable — an in-flight or completed run must not
 * have its workflow replayed out from under it. Mirrors the Python
 * `restart_run` guard (content_tool/api/routes/runs.py).
 */
export function restartGuard(
  run: { status: string } | undefined,
): RestartGuard {
  if (run === undefined) return { error: "not_found" };
  if (run.status !== "failed") return { error: "not_failed" };
  return { ok: true };
}
