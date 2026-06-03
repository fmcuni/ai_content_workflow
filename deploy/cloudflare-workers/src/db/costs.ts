// Cost queries + hand-rolled aggregation. No pandas: token sums are computed in
// plain JS and rates applied per the Python `CostCalculator.estimate_cents`.
//
// EXACT cost math (mirrors content_tool/observability/cost.py):
//   usd = tokens_in/1e6 * input_rate
//       + tokens_out/1e6 * output_rate
//       + thinking_tokens/1e6 * thinking_rate
//   cents = int(usd * 100)   // Python int() TRUNCATES toward zero
//
// Per-run cost is priced by the model the run actually used: gap_analyses.model
// (the only per-run model record). Create-mode runs have no GA row, so the
// caller passes a `fallbackModel` (GEMINI_MODEL ?? DEFAULT_MODEL) used in that
// case — mirroring the Python route's `ga.model if ga else settings.gemini_model`.
// refresh_scan_30d does NOT use these rates — it sums the precomputed
// `est_cost_usd_cents` column straight from refresh_evaluations.

import { PRICING } from "../config/pricing";
import type { getSql } from "./client";

/** Fallback Gemini model when a run has no gap-analysis row (create mode). */
export const DEFAULT_MODEL = "gemini-3.1-pro-preview";

/** Token triple summed across a run's gap analysis + drafts. */
export interface TokenTotals {
  tokens_in: number;
  tokens_out: number;
  thinking_tokens: number;
}

/**
 * Port of `CostCalculator.estimate_cents`. Returns integer USD cents.
 * Rounding mode: TRUNCATION toward zero (Python `int(usd * 100)`), achieved
 * here with `Math.trunc`. Unknown model → 0 (matches `prices.get(model)` None).
 */
export function estimateCents(
  model: string,
  tokensIn: number,
  tokensOut: number,
  thinkingTokens: number,
): number {
  const p = PRICING[model];
  if (!p) {
    return 0;
  }
  const usd =
    (tokensIn / 1_000_000) * p.input_per_million_usd +
    (tokensOut / 1_000_000) * p.output_per_million_usd +
    (thinkingTokens / 1_000_000) * p.thinking_per_million_usd;
  return Math.trunc(usd * 100);
}

/** Coerce a nullable numeric column to 0, mirroring Python `x or 0`. */
function n(value: number | null | undefined): number {
  return value ?? 0;
}

interface RunTokenRow {
  run_id: string;
  // gap_analyses.model for the run (null when no GA row → create mode).
  ga_model: string | null;
  // GA columns are `integer` over the wire (numbers); draft columns come from
  // `SUM()` and arrive as strings under `fetch_types: false` — both are coerced
  // through `num()` so the per-run math never falls into JS string concatenation.
  ga_tokens_in: string | number | null;
  ga_tokens_out: string | number | null;
  ga_thinking_tokens: string | number | null;
  draft_tokens_in: string | number | null;
  draft_tokens_out: string | number | null;
  draft_thinking_tokens: string | number | null;
}

/**
 * Pure per-run aggregation: GA triple (≤1 row/run) + the per-run draft SUM,
 * mirroring Python `(ga.x or 0) + sum(draft.x or 0)`, then truncated to cents
 * INDEPENDENTLY per run (matching each `estimate_cents` call in the Python loop).
 *
 * Every field is funneled through `num()` so string-valued `SUM()` results are
 * added arithmetically, never concatenated. Returns both the token totals and
 * the truncated per-run cents.
 */
export function runTokensAndCents(
  row: RunTokenRow,
  fallbackModel: string,
): { totals: TokenTotals; cents: number } {
  const totals: TokenTotals = {
    tokens_in: num(row.ga_tokens_in) + num(row.draft_tokens_in),
    tokens_out: num(row.ga_tokens_out) + num(row.draft_tokens_out),
    thinking_tokens: num(row.ga_thinking_tokens) + num(row.draft_thinking_tokens),
  };
  return {
    totals,
    cents: estimateCents(
      row.ga_model ?? fallbackModel,
      totals.tokens_in,
      totals.tokens_out,
      totals.thinking_tokens,
    ),
  };
}

/** Sum truncated per-run cents across all run rows (Python total_cents loop). */
export function sumRunCents(rows: readonly RunTokenRow[], fallbackModel: string): number {
  let totalCents = 0;
  for (const row of rows) {
    totalCents += runTokensAndCents(row, fallbackModel).cents;
  }
  return totalCents;
}

interface RefreshScanRow {
  tokens_in: string | number | null;
  tokens_out: string | number | null;
  cents: string | number | null;
}

/** postgres.js returns SUM()/numeric as strings; coerce to a JS number. */
function num(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  return typeof value === "string" ? Number(value) : value;
}

export interface CostSummary {
  runs: number;
  total_usd_cents: number;
  refresh_scan_30d: {
    tokens_in: number;
    tokens_out: number;
    cents: number;
  };
}

/**
 * Replicates `/costs/summary`. Sums the gap-analysis row (one-or-none per run)
 * plus all drafts per run, prices each run at its own `gap_analyses.model`
 * (or `fallbackModel` when the run has no GA row), truncates to cents PER RUN,
 * then sums those per-run cents — exactly as the Python loop does (each
 * `estimate_cents` call truncates independently before summing).
 *
 * `refresh_scan_30d` is ALWAYS the last 30 days from refresh_evaluations
 * (hardcoded `now() - INTERVAL '30 days'`), independent of [start, end].
 */
export async function getCostSummary(
  sql: ReturnType<typeof getSql>,
  start: string,
  end: string,
  fallbackModel: string,
): Promise<CostSummary> {
  // One row per run, with token totals split into GA vs drafts so we can match
  // the Python `(ga.x or 0) + sum(draft.x or 0)` semantics in JS.
  //
  // Drafts are pre-aggregated in their OWN `GROUP BY run_id` subquery and joined
  // 1:1 (gap_analyses is PK(run_id), so also ≤1 row/run). This guarantees no
  // cartesian fan-out: each run yields exactly one row carrying its GA triple
  // and its full draft SUM — never a draft sum multiplied by sibling rows.
  //
  // `SUM()` arrives as a STRING under `fetch_types: false`; `runTokensAndCents`
  // coerces every field through `num()` so the per-run math is arithmetic, not
  // JS string concatenation (the prior `n()` path concatenated and inflated).
  //
  // Date window mirrors `created_at >= start 00:00:00` .. `<= end 23:59:59.999999`
  // via `< end + 1 day`.
  const rows = await sql<RunTokenRow[]>`
    SELECT
      r.run_id                       AS run_id,
      ga.model                       AS ga_model,
      ga.tokens_in                   AS ga_tokens_in,
      ga.tokens_out                  AS ga_tokens_out,
      ga.thinking_tokens             AS ga_thinking_tokens,
      COALESCE(d.tokens_in, 0)       AS draft_tokens_in,
      COALESCE(d.tokens_out, 0)      AS draft_tokens_out,
      COALESCE(d.thinking_tokens, 0) AS draft_thinking_tokens
    FROM content_tool.runs r
    LEFT JOIN content_tool.gap_analyses ga ON ga.run_id = r.run_id
    LEFT JOIN (
      SELECT
        run_id,
        SUM(tokens_in)       AS tokens_in,
        SUM(tokens_out)      AS tokens_out,
        SUM(thinking_tokens) AS thinking_tokens
      FROM content_tool.drafts
      GROUP BY run_id
    ) d ON d.run_id = r.run_id
    WHERE r.created_at >= ${start}::date
      AND r.created_at < (${end}::date + INTERVAL '1 day')
  `;

  const totalCents = sumRunCents(rows, fallbackModel);

  const refreshRows = await sql<RefreshScanRow[]>`
    SELECT
      COALESCE(SUM(tokens_in), 0)          AS tokens_in,
      COALESCE(SUM(tokens_out), 0)         AS tokens_out,
      COALESCE(SUM(est_cost_usd_cents), 0) AS cents
    FROM content_tool.refresh_evaluations
    WHERE evaluated_at >= now() - INTERVAL '30 days'
  `;
  const refresh = refreshRows[0] ?? { tokens_in: 0, tokens_out: 0, cents: 0 };

  return {
    runs: rows.length,
    total_usd_cents: totalCents,
    refresh_scan_30d: {
      tokens_in: Math.trunc(num(refresh.tokens_in)),
      tokens_out: Math.trunc(num(refresh.tokens_out)),
      cents: Math.trunc(num(refresh.cents)),
    },
  };
}

export interface RunCost extends TokenTotals {
  est_usd_cents: number;
}

/**
 * Replicates `/costs/run/{run_id}`. Returns null when neither a gap-analysis
 * row nor any drafts exist (Python raises 404 "no usage").
 */
export async function getRunCost(
  sql: ReturnType<typeof getSql>,
  runId: string,
  fallbackModel: string,
): Promise<RunCost | null> {
  const gaRows = await sql<
    {
      model: string | null;
      tokens_in: number | null;
      tokens_out: number | null;
      thinking_tokens: number | null;
    }[]
  >`
    SELECT model, tokens_in, tokens_out, thinking_tokens
    FROM content_tool.gap_analyses
    WHERE run_id = ${runId}::uuid
    LIMIT 1
  `;
  const draftRows = await sql<
    { tokens_in: number | null; tokens_out: number | null; thinking_tokens: number | null }[]
  >`
    SELECT tokens_in, tokens_out, thinking_tokens
    FROM content_tool.drafts
    WHERE run_id = ${runId}::uuid
  `;

  const ga = gaRows[0];
  if (!ga && draftRows.length === 0) {
    return null;
  }

  let tin = n(ga?.tokens_in);
  let tout = n(ga?.tokens_out);
  let tthk = n(ga?.thinking_tokens);
  for (const d of draftRows) {
    tin += n(d.tokens_in);
    tout += n(d.tokens_out);
    tthk += n(d.thinking_tokens);
  }

  return {
    tokens_in: tin,
    tokens_out: tout,
    thinking_tokens: tthk,
    est_usd_cents: estimateCents(ga?.model ?? fallbackModel, tin, tout, tthk),
  };
}
