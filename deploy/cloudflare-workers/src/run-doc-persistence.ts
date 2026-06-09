// Pure helpers for the RunDoc Postgres cold-store / backup layer.
//
// Kept out of run-doc.ts (which is workerd-only: it imports `cloudflare:workers`)
// so this logic can be unit-tested in a plain node-env vitest run without the
// workers pool. The DO wires these into its ensureLoaded()/persist() flow.

/**
 * Extract the run id from a `/runs/:id/doc` WebSocket-upgrade URL.
 *
 * The DO is addressed via `idFromName(runId)` but never receives that name, so
 * the only reliable source of the run id inside the DO is the request URL the
 * route forwarded. Returns null when the path does not match (the DO then
 * no-ops the Postgres path rather than guessing a bad key).
 */
export function parseRunIdFromUrl(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/^\/runs\/([^/]+)\/doc$/);
  return match ? decodeURIComponent(match[1]!) : null;
}
