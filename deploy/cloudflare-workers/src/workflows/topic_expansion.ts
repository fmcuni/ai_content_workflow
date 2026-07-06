/**
 * TopicExpansionWorkflow — Workers-native port of the Front II topic-expansion
 * subgraph (content_tool/graph/topic_expansion.py).
 *
 * Node order mirrors the Python graph exactly: topic_gen → fan_out (insert one
 * topic_candidates row per generated topic) → analyse_candidate (dedup + hot per
 * candidate, bounded concurrency) → aggregate. There is NO HITL interrupt: the
 * batch runs to `ready_for_review` and the human review happens out-of-band via
 * the REST endpoints (PATCH / skip / promote). Progress streams into the shared
 * RUN_STREAM Durable Object keyed by batch id, with the batch SSE envelope
 * { event, batch_id, timestamp, payload } (mirrors TopicBatchExecutor._emit).
 *
 * Statuses (content_tool): pending → generating → analysing →
 * ready_for_review | failed.
 */

import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

import type { Env } from "../index";
import { getSql } from "../db/client";
import { toJsonb } from "../db/serialize";
import { DoGeminiClient } from "../gemini/do_client";
import type { GeminiClient } from "../gemini/types";
import { runTopicGen } from "../agents/topic_gen";
import {
  analyseCandidateVerdict,
  resolveVoice,
  toStringArray,
} from "../agents/analyse_candidate";

const DEFAULT_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_THINKING_LEVEL = "HIGH";
/**
 * content_tool/graph/topic_expansion.py CONCURRENCY_CAP — analyse_candidate fan-out.
 * Lowered 5 -> 3: each candidate runs dedup (grounded search + per-chunk HEAD
 * resolves + a urlContext verdict) AND topic_hot (googleSearch + urlContext)
 * concurrently. At 5-way fan-out the combined load exhausted the Workers
 * per-invocation subrequest budget, making stage-1 resolves fail silently so
 * real articles were reported as "no" (see Stage1Diagnostics). Kept in sync
 * with the Python CONCURRENCY_CAP.
 */
const CONCURRENCY_CAP = 3;

// DEFAULT_VOICE / resolveVoice / toStringArray / analyseCandidateVerdict now
// live in ../agents/analyse_candidate so the retry-verdict REST route shares
// the exact same logic.

interface Params {
  batchId: string;
}

/** Raw topic_batches row (jsonb arrays arrive as unknown/raw text). */
interface BatchRawRow {
  research_theme: string;
  target_audience: string;
  topic_count: number;
  keywords_per_topic: number;
  must_cover: unknown;
  must_avoid: unknown;
  priority_focus: string | null;
  notes: string | null;
  persona_default: string | null;
}

/** Serializable batch view threaded across the step boundary (arrays normalised). */
interface BatchRow {
  research_theme: string;
  target_audience: string;
  topic_count: number;
  keywords_per_topic: number;
  must_cover: string[];
  must_avoid: string[];
  priority_focus: string | null;
  notes: string | null;
  persona_default: string | null;
}

interface GeneratedTopic {
  topic: string;
  keywords: string[];
}

export class TopicExpansionWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<{ batchId: string }> {
    const { batchId } = event.payload;
    try {
      await this.runBatch(batchId, step);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await step.do("on-error-persist", async () => {
        await this.withSql(async (sql) => {
          await sql`
            UPDATE content_tool.topic_batches
            SET status = 'failed', last_error = ${message}
            WHERE batch_id = ${batchId}::uuid
          `;
        });
        return "ok";
      });
      await this.emitStep(step, "emit-graph-error", batchId, "graph.error", { message });
      throw err;
    }
    return { batchId };
  }

  private async runBatch(batchId: string, step: WorkflowStep): Promise<void> {
    // --- 1. load batch brief ----------------------------------------------
    const batch: BatchRow = await step.do("load-batch", async () =>
      this.withSql<BatchRow>(async (sql) => {
        const rows = await sql<BatchRawRow[]>`
          SELECT research_theme, target_audience, topic_count, keywords_per_topic,
                 must_cover, must_avoid, priority_focus, notes, persona_default
          FROM content_tool.topic_batches
          WHERE batch_id = ${batchId}::uuid
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) {
          throw new Error(`topic batch not found: ${batchId}`);
        }
        // Normalise jsonb arrays to string[] so the step result is Serializable.
        return {
          ...row,
          must_cover: toStringArray(row.must_cover),
          must_avoid: toStringArray(row.must_avoid),
        };
      }),
    );

    // --- 2. topic_gen ------------------------------------------------------
    await this.statusStep(step, "status-generating", batchId, "generating");
    await this.emitStep(step, "emit-topic-gen-start", batchId, "topic_gen.start", {});
    const generated: GeneratedTopic[] = await step.do("topic-gen", async () =>
      this.withSql<GeneratedTopic[]>(async (sql) => {
        const gemini = this.geminiClient();
        const { output } = await runTopicGen(sql, gemini, {
          researchTheme: batch.research_theme,
          targetAudience: batch.target_audience,
          topicCount: batch.topic_count,
          keywordsPerTopic: batch.keywords_per_topic,
          mustCover: batch.must_cover,
          mustAvoid: batch.must_avoid,
          priorityFocus: batch.priority_focus,
          notes: batch.notes,
          voiceSlug: resolveVoice(batch.persona_default),
        });
        return output.topics.map((t) => ({ topic: t.topic, keywords: t.keywords }));
      }),
    );
    await this.emitStep(step, "emit-topic-gen-done", batchId, "topic_gen.done", {
      count: generated.length,
    });

    // --- 3. fan_out: persist one candidate row per generated topic --------
    await this.statusStep(step, "status-analysing", batchId, "analysing");
    await this.emitStep(step, "emit-fan-out-start", batchId, "fan_out.start", {});
    const candidateIds: string[] = await step.do("fan-out", async () =>
      this.withSql<string[]>(async (sql) => {
        const ids: string[] = [];
        for (let i = 0; i < generated.length; i += 1) {
          const g = generated[i]!;
          const rows = await sql<Array<{ candidate_id: string }>>`
            INSERT INTO content_tool.topic_candidates
              (candidate_id, batch_id, position, status, topic, keywords,
               original_topic, original_keywords)
            VALUES (
              gen_random_uuid(), ${batchId}::uuid, ${i}, 'candidate',
              ${g.topic}, ${toJsonb(sql, g.keywords)},
              ${g.topic}, ${toJsonb(sql, g.keywords)}
            )
            RETURNING candidate_id
          `;
          ids.push(rows[0]!.candidate_id);
        }
        return ids;
      }),
    );
    await this.emitStep(step, "emit-fan-out-done", batchId, "fan_out.done", {
      count: candidateIds.length,
    });

    // --- 4. analyse_candidate (dedup + hot) with bounded concurrency ------
    // Each candidate is its own durable step; chunks run concurrently up to
    // CONCURRENCY_CAP via Promise.all (mirrors the Python asyncio.Semaphore).
    await this.emitStep(step, "emit-analyse-start", batchId, "analyse_candidate.start", {});
    for (let i = 0; i < candidateIds.length; i += CONCURRENCY_CAP) {
      const chunk = candidateIds.slice(i, i + CONCURRENCY_CAP);
      await Promise.all(
        chunk.map((cid) =>
          step.do(`analyse-${cid}`, async () =>
            this.analyseCandidate(cid, batch.persona_default),
          ),
        ),
      );
    }
    await this.emitStep(step, "emit-analyse-done", batchId, "analyse_candidate.done", {
      count: candidateIds.length,
    });

    // --- 5. aggregate ------------------------------------------------------
    await this.emitStep(step, "emit-aggregate-start", batchId, "aggregate.start", {});
    const finalStatus = await step.do("aggregate", async () =>
      this.withSql<string>(async (sql) => {
        const rows = await sql<Array<{ total: number; errored: number }>>`
          SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE last_error IS NOT NULL)::int AS errored
          FROM content_tool.topic_candidates
          WHERE batch_id = ${batchId}::uuid
        `;
        const row = rows[0];
        // All candidates errored (or none generated) → failed; else reviewable.
        const status =
          row === undefined || row.total === 0 || row.errored >= row.total
            ? "failed"
            : "ready_for_review";
        await sql`
          UPDATE content_tool.topic_batches SET status = ${status}
          WHERE batch_id = ${batchId}::uuid
        `;
        return status;
      }),
    );
    await this.emitStep(step, "emit-aggregate-done", batchId, "aggregate.done", {
      status: finalStatus,
    });
    await this.emitStep(step, "emit-graph-completed", batchId, "graph.completed", {});
  }

  /**
   * Run dedup + hot for a single candidate concurrently and persist both
   * verdicts. A failure of either agent is captured in `last_error` (the row is
   * NOT failed hard) — mirrors n_analyse_candidate's partial-failure handling.
   */
  private async analyseCandidate(
    candidateId: string,
    personaDefault: string | null,
  ): Promise<string> {
    await this.withSql(async (sql) =>
      analyseCandidateVerdict(sql, this.geminiClient(), candidateId, personaDefault),
    );
    return "ok";
  }

  // -------------------------------------------------------------------------
  // Helpers (mirror ProductionWorkflow's, scoped to the batch SSE envelope).
  // -------------------------------------------------------------------------

  private async emit(
    batchId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const envelope = {
      event: eventName,
      batch_id: batchId,
      timestamp: new Date().toISOString(),
      payload,
    };
    await this.env.RUN_STREAM.get(this.env.RUN_STREAM.idFromName(batchId)).fetch(
      "https://run-stream/append",
      { method: "POST", body: JSON.stringify(envelope) },
    );
  }

  private async setStatus(batchId: string, status: string): Promise<void> {
    await this.withSql(async (sql) => {
      await sql`
        UPDATE content_tool.topic_batches SET status = ${status}
        WHERE batch_id = ${batchId}::uuid
      `;
      return undefined;
    });
  }

  // Durable side-effect wrappers — on a Workflows replay after hibernation the
  // run() body re-executes; only completed step.do() callbacks are memoized. A
  // bare setStatus/emit would re-fire on every wake (duplicate status writes +
  // duplicate batch SSE events), so each runs inside a uniquely-labelled step.

  private async statusStep(
    step: WorkflowStep,
    label: string,
    batchId: string,
    status: string,
  ): Promise<void> {
    await step.do(label, async () => {
      await this.setStatus(batchId, status);
      return "ok";
    });
  }

  private async emitStep(
    step: WorkflowStep,
    label: string,
    batchId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await step.do(label, async () => {
      await this.emit(batchId, eventName, payload);
      return "ok";
    });
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
