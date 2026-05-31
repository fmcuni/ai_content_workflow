// Port of content_tool/compliance/log.py → TypeScript for Cloudflare Workers.
//
// Single exported function: writeComplianceLog
//   Gathers run/draft/audit/gap-analysis/citation data, then INSERTs one row
//   into content_tool.compliance_log.  Idempotent via
//   INSERT … ON CONFLICT (run_id) DO NOTHING.
//
// Token-sum rule (mirrors Python exactly):
//   total_tokens = SUM over all drafts of (tokens_in + tokens_out + thinking_tokens)
//                + ga.tokens_in + ga.tokens_out + ga.thinking_tokens (0 when no GA row)
//   est_cost_usd_cents is computed with estimateCents(model, total_in, total_out, total_thinking)
//   where total_in/out/thinking are the same GA-inclusive sums (split by axis).
//
// sources_cited  = sorted, deduplicated citation.domain WHERE was_displayed=true AND domain non-null
//   NOTE: Python does NOT additionally filter `policy_decision != 'denied'` for sources_cited —
//   it only checks `was_displayed`. The denied set is a separate filter on policy_decision='denied'.
// sources_denied = sorted, deduplicated citation.domain WHERE policy_decision='denied' AND domain non-null

import type { getSql } from "../db/client";
import { toJsonb } from "../db/serialize";
import { estimateCents } from "../db/costs";

// ---------------------------------------------------------------------------
// Local row-shape interfaces — only the columns queried by this module.
// (The shared RunRow in schema.ts is a cost-subset; we need compliance columns.)
// ---------------------------------------------------------------------------

interface RunComplianceRow {
  run_id: string;
  persona: string;
  article_url: string | null;
  wp_pushed_post_id: number | null;
  chosen_route: string | null;
  approved_by: string | null;
  iteration_count: number;
}

interface DraftTokenRow {
  draft_id: string;
  iteration: number;
  tokens_in: number | null;
  tokens_out: number | null;
  thinking_tokens: number | null;
}

interface GaTokenRow {
  tokens_in: number | null;
  tokens_out: number | null;
  thinking_tokens: number | null;
}

interface AuditRunRow {
  overall_pass: boolean;
  severity_high: number;
  severity_medium: number;
  severity_low: number;
}

interface CitationRow {
  domain: string | null;
  was_displayed: boolean;
  policy_decision: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce nullable numeric DB column to 0 (mirrors Python `x or 0`). */
function n(value: number | null | undefined): number {
  return value ?? 0;
}

/**
 * Build sorted, deduplicated semicolon-joined domain string.
 * Mirrors Python: `";".join(sorted({c.domain for c in citations if <predicate>}))`
 */
function joinDomains(domains: (string | null)[]): string {
  const unique = [...new Set(domains.filter((d): d is string => d !== null && d !== ""))];
  return unique.sort().join(";");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Writes one compliance-log row for the given run.
 * Silently no-ops when:
 *   - no drafts exist for the run (mirrors Python's early return)
 *   - the row already exists (ON CONFLICT DO NOTHING)
 */
export async function writeComplianceLog(
  sql: ReturnType<typeof getSql>,
  runId: string,
  geminiModel: string,
): Promise<void> {
  // 1. Fetch the run row (compliance-relevant columns only).
  const runRows = await sql<RunComplianceRow[]>`
    SELECT
      run_id,
      persona,
      article_url,
      wp_pushed_post_id,
      chosen_route,
      approved_by,
      iteration_count
    FROM content_tool.runs
    WHERE run_id = ${runId}::uuid
    LIMIT 1
  `;
  const run: RunComplianceRow | undefined = runRows[0];
  if (run === undefined) {
    return;
  }

  // 2. Fetch all drafts for the run (token columns + id/iteration for grouping).
  const drafts = await sql<DraftTokenRow[]>`
    SELECT
      draft_id,
      iteration,
      tokens_in,
      tokens_out,
      thinking_tokens
    FROM content_tool.drafts
    WHERE run_id = ${runId}::uuid
    ORDER BY iteration ASC
  `;
  if (drafts.length === 0) {
    // No drafts → mirror Python early return, nothing to log.
    return;
  }

  // 3. Identify the latest draft by maximum iteration.
  // drafts is non-empty at this point (guarded above), so the cast is safe.
  const latestCandidate: DraftTokenRow | undefined = drafts.reduce(
    (best: DraftTokenRow | undefined, d) =>
      best === undefined || d.iteration > best.iteration ? d : best,
    undefined as DraftTokenRow | undefined,
  );
  if (latestCandidate === undefined) {
    return;
  }
  const latest: DraftTokenRow = latestCandidate;

  // 4. Fetch audit_run for the latest draft (may be null).
  const auditRows = await sql<AuditRunRow[]>`
    SELECT
      overall_pass,
      severity_high,
      severity_medium,
      severity_low
    FROM content_tool.audit_runs
    WHERE draft_id = ${latest.draft_id}::uuid
    LIMIT 1
  `;
  const audit = auditRows[0] ?? null;

  // 5. Fetch gap_analysis for the run (may be null — create-mode runs have none).
  const gaRows = await sql<GaTokenRow[]>`
    SELECT tokens_in, tokens_out, thinking_tokens
    FROM content_tool.gap_analyses
    WHERE run_id = ${runId}::uuid
    LIMIT 1
  `;
  const ga = gaRows[0] ?? null;
  const gaTokensIn = ga !== null ? n(ga.tokens_in) : 0;
  const gaTokensOut = ga !== null ? n(ga.tokens_out) : 0;
  const gaThinking = ga !== null ? n(ga.thinking_tokens) : 0;

  // 6. Fetch citations for the latest draft.
  const citations = await sql<CitationRow[]>`
    SELECT domain, was_displayed, policy_decision
    FROM content_tool.citations
    WHERE draft_id = ${latest.draft_id}::uuid
  `;

  // 7. Build domain lists (mirror Python set-comprehension + sorted + joined).
  const sourcesCited = joinDomains(
    citations.filter((c) => c.was_displayed).map((c) => c.domain),
  );
  const sourcesDenied = joinDomains(
    citations.filter((c) => c.policy_decision === "denied").map((c) => c.domain),
  );

  // 8. Token totals (GA-inclusive, split by axis for cost calc — mirrors Python).
  const draftTokensIn = drafts.reduce((sum, d) => sum + n(d.tokens_in), 0);
  const draftTokensOut = drafts.reduce((sum, d) => sum + n(d.tokens_out), 0);
  const draftThinking = drafts.reduce((sum, d) => sum + n(d.thinking_tokens), 0);

  const totalTokensIn = draftTokensIn + gaTokensIn;
  const totalTokensOut = draftTokensOut + gaTokensOut;
  const totalThinking = draftThinking + gaThinking;
  const totalTokens = totalTokensIn + totalTokensOut + totalThinking;

  const estCostUsdCents = estimateCents(geminiModel, totalTokensIn, totalTokensOut, totalThinking);

  // 9. Audit severity summary (JSONB).
  const auditSeveritySummary = {
    high: audit !== null ? audit.severity_high : 0,
    medium: audit !== null ? audit.severity_medium : 0,
    low: audit !== null ? audit.severity_low : 0,
  };

  // 10. INSERT … ON CONFLICT (run_id) DO NOTHING — idempotent.
  await sql`
    INSERT INTO content_tool.compliance_log (
      log_id,
      run_id,
      persona,
      article_url,
      wp_pushed_post_id,
      chosen_route,
      sources_cited,
      sources_denied,
      audit_overall_pass,
      audit_severity_summary,
      approver_email,
      iteration_count,
      gemini_model,
      total_tokens,
      est_cost_usd_cents
    ) VALUES (
      gen_random_uuid(),
      ${runId}::uuid,
      ${run.persona},
      ${run.article_url ?? ""},
      ${run.wp_pushed_post_id},
      ${run.chosen_route ?? "unknown"},
      ${sourcesCited},
      ${sourcesDenied},
      ${audit !== null ? audit.overall_pass : false},
      ${toJsonb(sql, auditSeveritySummary)},
      ${run.approved_by ?? "unknown"},
      ${run.iteration_count ?? 0},
      ${geminiModel},
      ${totalTokens},
      ${estCostUsdCents}
    )
    ON CONFLICT (run_id) DO NOTHING
  `;
}
