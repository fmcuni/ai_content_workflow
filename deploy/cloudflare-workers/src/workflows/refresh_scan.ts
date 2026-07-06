/**
 * RefreshScanWorkflow — Workers-native driver for the periodic REFRESH SCAN
 * (CMS Stage 0), porting `content_tool/refresh/scanner.scan_tick`.
 *
 * The cron trigger (and the manual /refresh/scan route) kick this workflow.
 *
 * Free-plan subrequest hardening
 * ------------------------------
 * Each article's deterministic audit fetches every external href in the body
 * (HEAD/GET, bounded by link_check_concurrency), and the budgeted LLM audit adds
 * more subrequests. On the Cloudflare Workers free plan a single invocation/step
 * is capped at ~50 subrequests, so wrapping the WHOLE tick (batch_size up to 200
 * articles) in one `step.do` would blow that budget at real inventory sizes.
 *
 * We therefore restructure the tick the same way TopicExpansionWorkflow handles
 * its per-candidate fan-out: a small `select-due` setup step picks the due
 * articles (advisory-lock soft guard + skipped bookkeeping), then EACH article is
 * scanned in its own durable `scan-{article_id}` step. Steps run in chunks of
 * `concurrency` via Promise.all (mirrors the Python asyncio.Semaphore), so each
 * article gets its own fresh subrequest budget and parallelism stays bounded.
 *
 * llm_cap_per_tick is preserved EXACTLY. The sequential `scan_tick` loop only
 * decrements the budget by the LLM calls an article actually consumes (a
 * deterministic-pass consumes nothing). Because parallel steps cannot share a
 * mutable counter deterministically, we reserve-then-refund per chunk: before a
 * chunk runs we hand `llmBudgetRemaining = 1` to the first `min(chunkSize,
 * remaining)` articles and `0` to the rest, then after the chunk we refund every
 * reserved slot that went unused (article passed deterministically / errored
 * before the LLM). The total LLM calls across the tick therefore never exceed
 * llm_cap_per_tick, identical to the sequential cap.
 *
 * All other semantics — staleness scoring + action thresholds, the
 * refresh_evaluations writes (incl. wp_post_not_found / wp_fetch_failed
 * branches), schedule advancement, the advisory-lock soft guard, the skipped
 * bookkeeping and the TickResult shape — are unchanged: every article still runs
 * through the same `scanArticle` used by the per-article route.
 */

import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

import type { Sql } from "postgres";

import type { Env } from "../index";
import { getSql } from "../db/client";
import { getRefreshConfig } from "../config/refresh";
import { DoGeminiClient } from "../gemini/do_client";
import type { GeminiClient } from "../gemini/types";
import {
  scanArticle,
  selectDueArticles,
  type ArticleRow,
  type TickResult,
  type TriggerSource,
} from "../refresh/scanner";

const DEFAULT_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_THINKING_LEVEL = "HIGH";

export interface RefreshScanParams {
  triggerSource: string;
  articleIds?: string[];
  force?: boolean;
}

/** Result of the `select-due` setup step, threaded across the step boundary. */
interface SelectDueStepResult {
  articles: ArticleRow[];
  skipped: Array<Record<string, string>>;
  startedAt: string;
}

/** Per-article scan outcome threaded out of a `scan-{id}` step. */
interface ArticleStepResult {
  ok: boolean;
  articleId: string;
  llmCallsUsed: number;
  estCostUsdCents: number;
}

export class RefreshScanWorkflow extends WorkflowEntrypoint<Env, RefreshScanParams> {
  async run(event: WorkflowEvent<RefreshScanParams>, step: WorkflowStep): Promise<TickResult> {
    const { triggerSource, articleIds, force } = event.payload;
    const source = normalizeTriggerSource(triggerSource);
    const cfg = getRefreshConfig().scan;

    // --- 1. setup: advisory-lock soft guard + select due + skipped bookkeeping
    const setup = await step.do("select-due", async () =>
      this.withSql<SelectDueStepResult>(async (sql) =>
        this.selectDue(sql, { articleIds, force }),
      ),
    );

    // --- 2. fan out: one durable step per article, chunked by concurrency -----
    // The LLM budget is reserved-then-refunded per chunk so the per-tick cap is
    // preserved exactly across the otherwise-parallel steps (see file header).
    const concurrency = Math.max(1, cfg.concurrency);
    let llmBudget = cfg.llm_cap_per_tick;
    const outcomes: ArticleStepResult[] = [];

    for (let i = 0; i < setup.articles.length; i += concurrency) {
      const chunk = setup.articles.slice(i, i + concurrency);
      const reservedThisChunk = Math.min(chunk.length, Math.max(0, llmBudget));

      const chunkResults = await Promise.all(
        chunk.map((article, idx) => {
          // First `reservedThisChunk` articles in the chunk may call the LLM.
          const llmBudgetRemaining = idx < reservedThisChunk ? 1 : 0;
          return step.do(`scan-${article.article_id}`, async () =>
            this.withSql<ArticleStepResult>(async (sql) =>
              this.scanOne(sql, article, source, llmBudgetRemaining),
            ),
          );
        }),
      );

      // Reconcile budget: spend what was actually used, refund unused reservations.
      const usedThisChunk = chunkResults.reduce((sum, r) => sum + r.llmCallsUsed, 0);
      llmBudget -= usedThisChunk;
      outcomes.push(...chunkResults);
    }

    // --- 3. aggregate counts into the TickResult envelope ---------------------
    // `finishedAt` is stamped inside a step so it is memoized: a bare new Date()
    // in the run() body would re-stamp to a later wall-clock time on every replay
    // after hibernation, making the returned TickResult non-deterministic.
    const finishedAt = await step.do("finished-at", async () => new Date().toISOString());
    const result: TickResult = {
      scanned: 0,
      evaluationsCreated: 0,
      llmCalls: 0,
      estCostUsdCents: 0,
      startedAt: setup.startedAt,
      finishedAt,
      skipped: [...setup.skipped],
    };

    for (const outcome of outcomes) {
      if (outcome.ok) {
        result.scanned += 1;
        result.evaluationsCreated += 1;
        result.llmCalls += outcome.llmCallsUsed;
        result.estCostUsdCents += outcome.estCostUsdCents;
      } else {
        result.skipped.push({ article_id: outcome.articleId, reason: "scan_exception" });
      }
    }

    return result;
  }

  /**
   * Setup phase, ported from the head of `scanTick`: best-effort advisory-lock
   * soft guard, select due (or forced) articles, and record any requested ids
   * that were filtered out.
   */
  private async selectDue(
    sql: Sql,
    opts: { articleIds?: string[]; force?: boolean },
  ): Promise<SelectDueStepResult> {
    const cfg = getRefreshConfig().scan;
    const startedAt = new Date().toISOString();

    // Best-effort soft guard — a TRANSACTION-scoped try-lock that auto-releases
    // at the end of this statement's implicit txn (a session-scoped lock is
    // unreliable through Hyperdrive's pooled connections). Advisory-only:
    // correctness for concurrent ticks relies on the per-article in-flight-run
    // filter + supersede. Unchanged from the original scanTick.
    const lockRows = await sql<Array<{ got: boolean }>>`
      SELECT pg_try_advisory_xact_lock(${cfg.tick_lock_key}) AS got
    `;
    void lockRows;

    const articles = await selectDueArticles(sql, {
      limit: cfg.batch_size,
      articleIds: opts.articleIds,
      force: opts.force,
    });

    const skipped: Array<Record<string, string>> = [];
    if (opts.articleIds !== undefined) {
      const returned = new Set(articles.map((a) => a.article_id));
      for (const id of opts.articleIds) {
        if (!returned.has(id)) {
          skipped.push({ article_id: id, reason: "not_found_or_not_due" });
        }
      }
    }

    return { articles, skipped, startedAt };
  }

  /**
   * Scan a single article in its own step. Mirrors one iteration of the
   * sequential `scanTick` loop: a thrown `scanArticle` becomes an `ok: false`
   * outcome (recorded as a `scan_exception` skip), exactly as before.
   */
  private async scanOne(
    sql: Sql,
    article: ArticleRow,
    triggerSource: TriggerSource,
    llmBudgetRemaining: number,
  ): Promise<ArticleStepResult> {
    try {
      const scan = await scanArticle(sql, this.env, this.geminiClient(), article, {
        triggerSource,
        llmBudgetRemaining,
      });
      return {
        ok: true,
        articleId: article.article_id,
        llmCallsUsed: scan.llmCallsUsed,
        estCostUsdCents: scan.estCostUsdCents,
      };
    } catch {
      return { ok: false, articleId: article.article_id, llmCallsUsed: 0, estCostUsdCents: 0 };
    }
  }

  /** Runs `fn` against the shared per-isolate cached client (src/db/client.ts)
   * — no longer opens/closes a connection per call; self-heals the cache on a
   * connection-flavored error before the platform's own step retry re-runs
   * this. */
  private async withSql<T>(fn: (sql: ReturnType<typeof getSql>) => Promise<T>): Promise<T> {
    const sql = getSql(this.env);
    try {
      return await fn(sql);
    } finally {
      await sql.end().catch(() => undefined);
    }
  }

  private geminiClient(): GeminiClient {
    return new DoGeminiClient(this.env.GEMINI_PROXY, {
      model: this.env.GEMINI_MODEL ?? DEFAULT_MODEL,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
    });
  }
}

/** Map an arbitrary trigger string to a known TriggerSource (default "cron"). */
function normalizeTriggerSource(raw: string): TriggerSource {
  if (raw === "manual_api" || raw === "manual_per_article" || raw === "cron") {
    return raw;
  }
  return "cron";
}
