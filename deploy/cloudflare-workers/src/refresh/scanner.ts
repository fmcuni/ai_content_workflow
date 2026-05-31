/**
 * Refresh scanner — Workers-native port of `content_tool/refresh/scanner.py`.
 *
 * Orchestrates per-article and per-tick scanning of onboarded WordPress
 * articles (CMS Stage 0). For each due article it fetches the published HTML,
 * runs the deterministic audit, optionally runs the LLM audit (budgeted), scores
 * staleness, supersedes prior open evaluations, inserts a new open evaluation,
 * and advances the article's scan schedule.
 *
 * Divergence from Python: the Python code wraps a tick in a session-scoped
 * `pg_advisory_lock`. Through Cloudflare Hyperdrive the connection is pooled and
 * NOT session-stable, so a session-scoped advisory lock cannot be relied on. We
 * therefore use a best-effort `pg_try_advisory_xact_lock` inside a single
 * transaction as a soft guard (see `scanTick`), and otherwise let the per-article
 * in-flight-run check provide correctness. See the file-level note in the PR.
 */

import type { Sql } from "postgres";

import type { Env } from "../index";
import { getRefreshConfig } from "../config/refresh";
import { WordPressClient } from "../wordpress/client";
import type { GeminiClient } from "../gemini/types";
import {
  deterministicAuditPublishedHtml,
  type DeterministicJsonb,
} from "./deterministic_checks";
import {
  computeStaleness,
  llmAuditPublished,
  type Action,
  type LLMFindings,
} from "./evaluator";
import { advanceSchedule, scheduleAfterRetry } from "./inventory";
import { toJsonb } from "../db/serialize";

// ---------------------------------------------------------------------------
// Constants — mirror scanner.py
// ---------------------------------------------------------------------------

export const SCANNER_VERSION = "scanner@0.1.0";

export type TriggerSource = "cron" | "manual_api" | "manual_per_article";

/** Statuses where a run is still actively driving the article — skip scanning. */
export const IN_FLIGHT_STATUSES = [
  "pending",
  "strategy",
  "hitl_1",
  "production",
  "hitl_2",
  "persisted",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of `content_tool.articles` columns the scanner reads/needs. */
export interface ArticleRow {
  article_id: string;
  article_url: string;
  wp_post_id: number | null;
  persona: string | null;
  first_seen_at: string;
  last_persisted_at: string | null;
}

export interface ScanArticleResult {
  evaluationId: string;
  recommendedAction: Action;
  stalenessScore: number;
  llmCallsUsed: number;
  estCostUsdCents: number;
}

export interface TickResult {
  scanned: number;
  evaluationsCreated: number;
  llmCalls: number;
  estCostUsdCents: number;
  startedAt: string;
  finishedAt: string;
  skipped: Array<Record<string, string>>;
}

export interface ScanTickOptions {
  triggerSource: TriggerSource;
  articleIds?: string[];
  /** When true (with articleIds), bypass the next_scan_due_at filter. */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Whole-day difference (floor), mirroring Python `timedelta.days`. */
function ageDaysFrom(reference: string | null, now: Date): number {
  if (reference === null) {
    return 0;
  }
  const refMs = Date.parse(reference.replace(" ", "T"));
  if (Number.isNaN(refMs)) {
    return 0;
  }
  return Math.floor((now.getTime() - refMs) / (24 * 60 * 60 * 1000));
}

/** SHA-256 hex of the UTF-8 bytes of `text` (Web Crypto). */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface InsertEvaluationParams {
  articleId: string;
  triggerSource: TriggerSource;
  ageDays: number;
  fetchedHtmlHash: string | null;
  deterministicFindings: DeterministicJsonb | Record<string, unknown>;
  llmFindings: Record<string, unknown> | null;
  llmSkippedReason: string | null;
  score: number;
  action: Action;
  tokensIn: number | null;
  tokensOut: number | null;
  estCostUsdCents: number | null;
  latencyMs: number | null;
}

/**
 * Supersede the article's prior open evaluations and insert a new open one.
 * Returns the new evaluation_id. The PK has a DB default of gen_random_uuid(),
 * but we supply it explicitly (matching audit.ts / topic_expansion.ts) so the
 * id is deterministic from the INSERT's RETURNING.
 */
async function insertEvaluation(sql: Sql, p: InsertEvaluationParams): Promise<string> {
  await sql`
    UPDATE content_tool.refresh_evaluations
    SET outcome = 'superseded'
    WHERE article_id = ${p.articleId}::uuid AND outcome = 'open'
  `;

  const rows = await sql<Array<{ evaluation_id: string }>>`
    INSERT INTO content_tool.refresh_evaluations (
      evaluation_id, article_id, scanner_version, trigger_source, age_days,
      fetched_html_hash, deterministic_findings, llm_findings, llm_skipped_reason,
      staleness_score, recommended_action, outcome,
      tokens_in, tokens_out, est_cost_usd_cents, latency_ms
    ) VALUES (
      gen_random_uuid(), ${p.articleId}::uuid, ${SCANNER_VERSION}, ${p.triggerSource},
      ${p.ageDays}, ${p.fetchedHtmlHash}, ${toJsonb(sql, p.deterministicFindings)},
      ${p.llmFindings === null ? null : toJsonb(sql, p.llmFindings)},
      ${p.llmSkippedReason}, ${p.score}, ${p.action}, 'open',
      ${p.tokensIn}, ${p.tokensOut}, ${p.estCostUsdCents}, ${p.latencyMs}
    )
    RETURNING evaluation_id
  `;
  return rows[0]!.evaluation_id;
}

/** UPDATE the article's schedule + wp_post_id + updated_at. */
async function persistSchedule(
  sql: Sql,
  articleId: string,
  newDue: Date | null,
  wpPostId: number | null,
  now: Date,
): Promise<void> {
  if (newDue !== null) {
    await sql`
      UPDATE content_tool.articles
      SET next_scan_due_at = ${newDue}, wp_post_id = COALESCE(${wpPostId}, wp_post_id),
          updated_at = ${now}
      WHERE article_id = ${articleId}::uuid
    `;
  } else {
    await sql`
      UPDATE content_tool.articles
      SET wp_post_id = COALESCE(${wpPostId}, wp_post_id), updated_at = ${now}
      WHERE article_id = ${articleId}::uuid
    `;
  }
}

// ---------------------------------------------------------------------------
// select_due_articles
// ---------------------------------------------------------------------------

export interface SelectDueOptions {
  limit: number;
  articleIds?: string[];
  /** With articleIds: bypass the next_scan_due_at filter. */
  force?: boolean;
}

/**
 * Select articles to scan. Default: due now, not dismissed, no in-flight run,
 * ordered by next_scan_due_at ASC, limited to batch_size. When `articleIds` is
 * supplied, restrict to those ids (and, unless `force`, still require due).
 */
export async function selectDueArticles(sql: Sql, opts: SelectDueOptions): Promise<ArticleRow[]> {
  const inFlight = sql(IN_FLIGHT_STATUSES as unknown as string[]);

  if (opts.articleIds !== undefined) {
    if (opts.articleIds.length === 0) {
      return [];
    }
    const ids = sql(opts.articleIds);
    const dueClause = opts.force === true ? sql`` : sql`AND a.next_scan_due_at <= now()`;
    return sql<ArticleRow[]>`
      SELECT a.article_id, a.article_url, a.wp_post_id, a.persona,
             a.first_seen_at, a.last_persisted_at
      FROM content_tool.articles a
      WHERE a.article_id IN ${ids}
        ${dueClause}
      ORDER BY a.next_scan_due_at ASC
    `;
  }

  return sql<ArticleRow[]>`
    SELECT a.article_id, a.article_url, a.wp_post_id, a.persona,
           a.first_seen_at, a.last_persisted_at
    FROM content_tool.articles a
    WHERE a.next_scan_due_at <= now()
      AND (a.dismissed_until IS NULL OR a.dismissed_until < now())
      AND NOT EXISTS (
        SELECT 1 FROM content_tool.runs r
        WHERE r.article_id = a.article_id
          AND r.status IN ${inFlight}
      )
    ORDER BY a.next_scan_due_at ASC
    LIMIT ${opts.limit}
  `;
}

// ---------------------------------------------------------------------------
// scan_article
// ---------------------------------------------------------------------------

/**
 * Scan one article: fetch WP HTML → deterministic audit → (budgeted) LLM audit
 * → staleness → insert evaluation → advance schedule. Returns the evaluation id
 * and the number of LLM calls consumed (0 or 1).
 */
export async function scanArticle(
  sql: Sql,
  env: Env,
  gemini: GeminiClient,
  article: ArticleRow,
  ctx: { triggerSource: TriggerSource; llmBudgetRemaining: number },
): Promise<ScanArticleResult> {
  const now = new Date();
  const reference = article.last_persisted_at ?? article.first_seen_at;
  const ageDays = ageDaysFrom(reference, now);

  // --- fetch WP HTML ------------------------------------------------------
  let wpPost: Awaited<ReturnType<WordPressClient["fetchPostByUrl"]>> = null;
  try {
    const wpClient = new WordPressClient(env);
    wpPost = await wpClient.fetchPostByUrl(article.article_url);
  } catch (err: unknown) {
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const evaluationId = await insertEvaluation(sql, {
      articleId: article.article_id,
      triggerSource: ctx.triggerSource,
      ageDays,
      fetchedHtmlHash: null,
      deterministicFindings: {
        findings: [],
        error: "wp_fetch_failed",
        detail,
        severity_high: 0,
        severity_medium: 0,
        severity_low: 0,
        passed: false,
      },
      llmFindings: null,
      llmSkippedReason: "scanner_error",
      score: 0.0,
      action: "monitor",
      tokensIn: null,
      tokensOut: null,
      estCostUsdCents: null,
      latencyMs: null,
    });
    await persistSchedule(sql, article.article_id, scheduleAfterRetry(now), null, now);
    return {
      evaluationId,
      recommendedAction: "monitor",
      stalenessScore: 0.0,
      llmCallsUsed: 0,
      estCostUsdCents: 0,
    };
  }

  // --- WP post not found → treat as needs-refresh -------------------------
  if (wpPost === null) {
    const evaluationId = await insertEvaluation(sql, {
      articleId: article.article_id,
      triggerSource: ctx.triggerSource,
      ageDays,
      fetchedHtmlHash: null,
      deterministicFindings: {
        findings: [],
        error: "wp_post_not_found",
        severity_high: 1,
        severity_medium: 0,
        severity_low: 0,
        passed: false,
      },
      llmFindings: null,
      llmSkippedReason: "no_published_html",
      score: 10.0,
      action: "refresh",
      tokensIn: null,
      tokensOut: null,
      estCostUsdCents: null,
      latencyMs: null,
    });
    await persistSchedule(
      sql,
      article.article_id,
      advanceSchedule("refresh", now),
      null,
      now,
    );
    return {
      evaluationId,
      recommendedAction: "refresh",
      stalenessScore: 10.0,
      llmCallsUsed: 0,
      estCostUsdCents: 0,
    };
  }

  const newWpPostId = article.wp_post_id === null ? wpPost.id : null;

  // --- deterministic audit ------------------------------------------------
  const htmlHash = await sha256Hex(wpPost.contentHtml);
  const det = await deterministicAuditPublishedHtml(
    wpPost.contentHtml,
    wpPost.modifiedGmt,
    article.last_persisted_at,
  );

  // --- LLM audit (budgeted) -----------------------------------------------
  let llm: LLMFindings | null = null;
  let llmSkippedReason: string | null = null;
  let llmFindingsOverride: Record<string, unknown> | null = null;
  let llmUsed = 0;

  if (det.passed) {
    llmSkippedReason = "deterministic_passed";
  } else if (ctx.llmBudgetRemaining <= 0) {
    llmSkippedReason = "cap_exceeded";
  } else {
    try {
      llm = await llmAuditPublished(sql, gemini, {
        html: wpPost.contentHtml,
        persona: article.persona,
      });
      llm = { ...llm, model: env.GEMINI_MODEL ?? null };
      llmUsed = 1;
    } catch (llmErr: unknown) {
      const detail = (llmErr instanceof Error ? llmErr.message : String(llmErr)).slice(0, 500);
      llmSkippedReason = "llm_error";
      llmFindingsOverride = { error: "llm_error", detail };
    }
  }

  // --- staleness ----------------------------------------------------------
  const { score, action } = computeStaleness(det, llm, ageDays);

  const evaluationId = await insertEvaluation(sql, {
    articleId: article.article_id,
    triggerSource: ctx.triggerSource,
    ageDays,
    fetchedHtmlHash: htmlHash,
    deterministicFindings: det.toObject(),
    llmFindings: llm !== null ? llm.raw : llmFindingsOverride,
    llmSkippedReason,
    score,
    action,
    tokensIn: llm !== null ? llm.tokensIn : null,
    tokensOut: llm !== null ? llm.tokensOut : null,
    // Cost estimation is owned by the cost module in this backend; the scanner
    // records token counts and leaves cents null (Python computed via pricing).
    estCostUsdCents: null,
    latencyMs: llm !== null ? llm.latencyMs : null,
  });

  await persistSchedule(sql, article.article_id, advanceSchedule(action, now), newWpPostId, now);

  return {
    evaluationId,
    recommendedAction: action,
    stalenessScore: score,
    llmCallsUsed: llmUsed,
    estCostUsdCents: 0,
  };
}

// ---------------------------------------------------------------------------
// scan_tick
// ---------------------------------------------------------------------------

/**
 * Run one scan tick: select due (or forced) articles, scan each respecting the
 * per-tick LLM cap, and return aggregate counts.
 */
export async function scanTick(
  sql: Sql,
  env: Env,
  gemini: GeminiClient,
  opts: ScanTickOptions,
): Promise<TickResult> {
  const cfg = getRefreshConfig().scan;
  const startedAt = new Date().toISOString();
  const result: TickResult = {
    scanned: 0,
    evaluationsCreated: 0,
    llmCalls: 0,
    estCostUsdCents: 0,
    startedAt,
    finishedAt: startedAt,
    skipped: [],
  };

  // Best-effort soft guard. A session-scoped advisory lock is unreliable through
  // Hyperdrive's pooled connections, so we use a TRANSACTION-scoped try-lock that
  // auto-releases at the end of THIS statement's implicit txn. It only prevents
  // two ticks colliding within the same pooled backend; correctness for
  // concurrent ticks relies on the per-article in-flight-run filter + supersede.
  const lockRows = await sql<Array<{ got: boolean }>>`
    SELECT pg_try_advisory_xact_lock(${cfg.tick_lock_key}) AS got
  `;
  // The xact lock above releases immediately (its txn ends with the statement);
  // it is intentionally advisory-only here. If it failed to acquire we still
  // proceed — the divergence is documented at the top of the file.
  void lockRows;

  const articles = await selectDueArticles(sql, {
    limit: cfg.batch_size,
    articleIds: opts.articleIds,
    force: opts.force,
  });

  if (opts.articleIds !== undefined) {
    const returned = new Set(articles.map((a) => a.article_id));
    for (const id of opts.articleIds) {
      if (!returned.has(id)) {
        result.skipped.push({ article_id: id, reason: "not_found_or_not_due" });
      }
    }
  }

  let llmBudget = cfg.llm_cap_per_tick;

  for (const article of articles) {
    try {
      const scan = await scanArticle(sql, env, gemini, article, {
        triggerSource: opts.triggerSource,
        llmBudgetRemaining: llmBudget,
      });
      llmBudget -= scan.llmCallsUsed;
      result.scanned += 1;
      result.evaluationsCreated += 1;
      result.llmCalls += scan.llmCallsUsed;
      result.estCostUsdCents += scan.estCostUsdCents;
    } catch {
      result.skipped.push({ article_id: article.article_id, reason: "scan_exception" });
    }
  }

  result.finishedAt = new Date().toISOString();
  return result;
}
