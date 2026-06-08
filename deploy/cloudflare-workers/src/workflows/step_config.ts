/**
 * Cloudflare Workflow step config for the citation-resolution step.
 *
 * `resolve_citations` fans out one HEAD request per grounding chunk (each capped
 * at 5s in url_resolver) plus a SQL write per citation over Hyperdrive. With no
 * explicit config the step inherits Cloudflare's *default* 10-minute step
 * timeout, so a single hung query stalls the whole step until
 * `WorkflowTimeoutError: Execution timed out after 600000ms` fires — then retries
 * just as slowly. That is exactly what stranded prod run a6e897e1: attempt 1
 * burned the full 10 minutes and only attempt 2 recovered.
 *
 * Capping each attempt at 90s (generous — 8-wide HEADs at a 5s cap clear hundreds
 * of chunks comfortably) and letting cheap exponential retries do the recovery
 * turns a 10-minute silent stall into a fast self-heal. Citation resolution is
 * best-effort decoration of the draft, so bounded fast retries are the right
 * failure mode. Pairs with the connection `statement_timeout` in db/client.ts,
 * which aborts the hung query itself so it never reaches this ceiling.
 */
export const CITATIONS_STEP_CONFIG = {
  retries: { limit: 6, delay: "5 seconds", backoff: "exponential" },
  timeout: "90 seconds",
} as const;
