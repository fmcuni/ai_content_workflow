// ── Client-side bulk fan-out ────────────────────────────────────────────────
// The ledger's bulk actions (set CMS metadata / approve & publish / restart /
// reject) have NO dedicated backend endpoint — spec §6 mandates a client-side
// fan-out over the existing per-run endpoints with bounded concurrency, per-run
// success/error collection and an aggregate result the toast + retry flow read.
// Pure (the per-run `worker` is injected), so the pool + aggregation is unit
// tested without the network.

export interface BulkItemResult {
  id: string;
  ok: boolean;
  /** Error message when `ok` is false; used for the per-run retry detail. */
  error?: string;
}

export interface BulkOutcome {
  results: BulkItemResult[];
  /** ids that succeeded. */
  succeeded: string[];
  /** ids that failed — the caller keeps these selected for retry (spec §6). */
  failed: string[];
}

const DEFAULT_CONCURRENCY = 4;

/**
 * Run `worker(id)` for each id with at most `concurrency` in flight. Never
 * rejects: a worker that throws is recorded as a failed item so one bad run
 * can't abort the batch. Preserves input order in `results`.
 */
export async function runBulk(
  ids: readonly string[],
  worker: (id: string) => Promise<unknown>,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<BulkOutcome> {
  const results: BulkItemResult[] = new Array(ids.length);
  let next = 0;

  async function drainOne(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= ids.length) return;
      const id = ids[i];
      try {
        await worker(id);
        results[i] = { id, ok: true };
      } catch (e) {
        results[i] = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  const lanes = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: lanes }, () => drainOne()));

  const succeeded = results.filter((r) => r.ok).map((r) => r.id);
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  return { results, succeeded, failed };
}

/**
 * Aggregate-toast line for a bulk outcome, e.g. `8 updated, 1 failed — retry`.
 * `verb` is the past-tense action word ("updated", "published", "restarted").
 */
export function summarizeBulk(outcome: BulkOutcome, verb: string): string {
  const ok = outcome.succeeded.length;
  const bad = outcome.failed.length;
  if (bad === 0) return `${ok} ${verb}`;
  if (ok === 0) return `${bad} failed — retry`;
  return `${ok} ${verb}, ${bad} failed — retry`;
}
