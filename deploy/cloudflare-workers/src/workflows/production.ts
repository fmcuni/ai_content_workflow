/**
 * ProductionWorkflow — the Workers-native port of the Python create-mode
 * pipeline (content_tool/graph + content_tool/api/sse.py RunExecutor).
 *
 * This COMPOSES the already-ported, tested node modules (outline, writer,
 * resolve_citations, render, audit, publish, compliance) — it does not
 * reimplement them. Each pipeline unit runs inside a `step.do(...)` so it is
 * checkpointed and retried independently; the two HITL gates pause durably via
 * `step.waitForEvent` (the Workers stand-in for LangGraph's interrupt_before).
 *
 * Event names and run status strings are reproduced EXACTLY from the Python
 * source so the frontend timeline (web/lib/sse.ts → SseEvent) and the runs row
 * stay byte-compatible across runtimes:
 *
 *   - `strategy.outline.done`          (LangGraph: namespace "strategy" + node "outline")
 *   - `production.writer.done`
 *   - `production.resolve_citations.done`
 *   - `production.render_html.done`
 *   - `production.audit.done`
 *   - `hitl.interrupted`               (payload `{ next: [...] }`)
 *   - `graph.completed`                (payload `{}`)
 *   - `graph.error`                    (payload `{ message }`)
 *
 * The SSE envelope mirrors RunExecutor._emit exactly:
 *   { event, run_id, iteration?, timestamp (ISO + "Z"), payload }
 */

import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

import type { Env } from "../index";
import { getSql } from "../db/client";
import { toJsonb, pgJson } from "../db/serialize";
import { DoGeminiClient } from "../gemini/do_client";
import type { GeminiClient } from "../gemini/types";
import { runOutline } from "../agents/outline";
import { runFetchArticle } from "../agents/fetch_article";
import { runGapAnalysis } from "../agents/gap_analysis";
import { runWriter, type RefineNote } from "../agents/writer";
import { resolveCitations, type GroundingChunk } from "../agents/citations";
import { renderHtml } from "../agents/render";
import { runAudit } from "../agents/audit";
import {
  WordPressClient,
  buildMeta,
  detectSeoPlugin,
  type PublishPayload,
  type SeoPlugin,
} from "../wordpress/client";
import { resolvePublishStatus } from "../wordpress/publish_status";
import { writeComplianceLog } from "../compliance/log";

// ---------------------------------------------------------------------------
// Constants — mirror the Python source exactly.
// ---------------------------------------------------------------------------

/** content_tool/graph/production.py MAX_ITERATIONS — internal audit loop. */
const MAX_ITERATIONS = 2;
/** content_tool/graph/root.py MAX_HITL2_ROUNDS — reviewer revision rounds. */
const MAX_HITL2_ROUNDS = 3;
/** Fallback Gemini model when GEMINI_MODEL var is unset (matches wrangler.jsonc). */
const DEFAULT_MODEL = "gemini-3.1-pro-preview";
/** Mirrors content_tool/gemini default thinking level. */
const DEFAULT_THINKING_LEVEL = "HIGH";
/** WordPress "use the theme default page template" — mirrors WP_DEFAULT_PAGE_TEMPLATE. */
const WP_DEFAULT_PAGE_TEMPLATE = "";
/** HITL waitForEvent timeout — generous so a paused run survives overnight. */
const HITL_TIMEOUT = "24 hours";

interface Params {
  runId: string;
}

// ---------------------------------------------------------------------------
// DB row shapes — only the columns this workflow reads. The shared RunRow in
// db/schema.ts is a cost-subset; create mode needs the full input + WP options.
// ---------------------------------------------------------------------------

/** Raw runs row as postgres.js returns it (keywords is JSONB → unknown). */
interface RunRawRow {
  run_id: string;
  status: string;
  start_mode: string;
  mode: string;
  topic: string;
  keywords: unknown;
  persona: string;
  topic_category: string | null;
  target_audience: string | null;
  edit_note: string | null;
  acf_adv_id: number;
  acf_widget_id: number;
  today_date: string;
  chosen_route: string | null;
  article_url: string | null;
  wp_pushed_post_id: number | null;
}

/**
 * Fully-serializable run view threaded through `step.do` boundaries (Workflow
 * step results must be `Serializable`, which rejects `unknown` — so `keywords`
 * is normalised to `string[]` at the load boundary).
 */
interface RunLoadRow {
  run_id: string;
  status: string;
  start_mode: string;
  mode: string;
  topic: string;
  keywords: string[];
  persona: string;
  topic_category: string | null;
  target_audience: string | null;
  edit_note: string | null;
  acf_adv_id: number;
  acf_widget_id: number;
  today_date: string;
  chosen_route: string | null;
  article_url: string | null;
  wp_pushed_post_id: number | null;
}

interface OutlinePayloadRow {
  payload: unknown;
}

interface DraftMarkupRow {
  draft_id: string;
  markup_raw: string;
  grounding_chunks: unknown;
  citation_intents: unknown;
}

interface RenderInputRow {
  final_markup: string | null;
}

interface Hitl2PersistRow {
  hitl_2_iteration: number;
  wp_publish_status: string | null;
  wp_author_id: number | null;
  wp_category_ids: unknown;
  wp_tag_ids: unknown;
  wp_featured_media_id: number | null;
  wp_slug: string | null;
  wp_excerpt: string | null;
}

interface RenderRowForPublish {
  seo_title: string;
  meta_description: string;
  html_body: string;
  schema_jsonld: unknown;
  excerpt_suggestion: string | null;
}

// ---------------------------------------------------------------------------
// HITL decision payloads delivered via `instance.sendEvent` from the routes.
// ---------------------------------------------------------------------------

type Hitl1Decision = "approve" | "edit_outline" | "override_route" | "cancel";

interface Hitl1Payload {
  decision: Hitl1Decision;
  notes?: string | null;
  /** edit_outline: the human-edited outline object replacing outlines.payload. */
  edited_outline?: object | null;
  /** override_route: the operator-chosen route written to runs.chosen_route. */
  new_route?: string | null;
}

type Hitl2Decision = "approve" | "request_changes" | "reject";

/** One reviewer comment anchored on a span of the draft. */
interface Hitl2Comment {
  anchor_text: string;
  comment: string;
}

interface Hitl2Payload {
  decision: Hitl2Decision;
  notes?: string | null;
  comments?: Hitl2Comment[] | null;
}

// ---------------------------------------------------------------------------
// Audit findings shape (subset read for the refine loop).
// ---------------------------------------------------------------------------

interface AuditFindingLike {
  severity?: string;
  must_fix?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export class ProductionWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<{ runId: string }> {
    const { runId } = event.payload;

    try {
      await this.runPipeline(runId, step);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Persist + surface the failure even when no SSE subscriber is listening
      // (mirrors RunExecutor._run's except branch).
      await step.do("on-error-persist", async () => {
        await this.withSql(async (sql) => {
          await sql`
            UPDATE content_tool.runs
            SET status = 'failed',
                error = ${toJsonb(sql, { type: errName(err), message })}
            WHERE run_id = ${runId}::uuid
          `;
        });
        return "ok";
      });
      await this.emitStep(step, "emit-graph-error", runId, "graph.error", { message });
      throw err;
    }

    return { runId };
  }

  // -------------------------------------------------------------------------
  // Pipeline body — mirrors the create-mode path through the LangGraph root.
  // -------------------------------------------------------------------------

  private async runPipeline(runId: string, step: WorkflowStep): Promise<void> {
    // --- 1. load-run -------------------------------------------------------
    // `run` is reassigned after refresh gap-analysis backfills chosen_route, so
    // the production loop's writer sees the resolved route (mirrors Python).
    let run: RunLoadRow = await step.do("load-run", async () =>
      this.withSql<RunLoadRow>(async (sql) => {
        const rows = await sql<RunRawRow[]>`
          SELECT run_id, status, start_mode, mode, topic, keywords, persona,
                 topic_category, target_audience, edit_note,
                 acf_adv_id, acf_widget_id, today_date, chosen_route,
                 article_url, wp_pushed_post_id
          FROM content_tool.runs
          WHERE run_id = ${runId}::uuid
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) {
          throw new Error(`run not found: ${runId}`);
        }
        // Normalise keywords (JSONB) to string[] so the result is Serializable.
        return { ...row, keywords: toStringArray(row.keywords) };
      }),
    );

    const keywords = run.keywords;
    const todayDate = run.today_date.slice(0, 10);

    // --- 2. strategy → outline --------------------------------------------
    // Refresh mode runs the strategy preamble (fetch_article → gap_analysis)
    // before the outline; create mode skips straight to the outline. Mirrors
    // content_tool/graph/strategy.py route_entry (create → "outline";
    // else → "fetch_article").
    if (run.start_mode === "refresh") {
      run = await this.runRefreshStrategy(runId, run, step, keywords, todayDate);
    } else {
      await this.statusStep(step, "status-strategy", runId, "strategy");
      await step.do("outline", async () =>
        this.withSql(async (sql) => {
          const gemini = this.geminiClient(runId);
          await runOutline(sql, gemini, {
            runId,
            startMode: "create",
            topic: run.topic,
            keywords,
            targetAudience: run.target_audience,
            acfAdvId: run.acf_adv_id,
            acfWidgetId: run.acf_widget_id,
            editNote: run.edit_note,
            todayDate,
          });
          return "ok";
        }),
      );
    }
    await this.emitStep(step, "emit-outline-done", runId, "strategy.outline.done", {});

    // --- 3. HITL_1 ---------------------------------------------------------
    await this.gateStep(step, "gate-hitl1", runId, "hitl_1", "hitl.interrupted", {
      next: ["production"],
    });
    const d1 = await step.waitForEvent<Hitl1Payload>("await-hitl1", {
      type: "hitl_1",
      timeout: HITL_TIMEOUT,
    });
    const cancelled = await step.do("apply-hitl1", async () =>
      this.applyHitl1(runId, d1.payload),
    );
    if (cancelled) {
      // Terminal: the operator cancelled at the outline gate.
      await this.emitStep(step, "emit-completed-cancel", runId, "graph.completed", {});
      return;
    }

    // --- 4 + 5. production loop → HITL_2 → (revise | publish) --------------
    let hitl2Iteration = 0;
    // refineNotes carried INTO the production loop. On the first pass this is
    // null; on a request_changes revision it carries reviewer comments.
    let reviewerRefineNotes: RefineNote[] | null = null;

    for (;;) {
      await this.runProductionLoop(runId, run, step, hitl2Iteration, reviewerRefineNotes);

      // --- HITL_2 ----------------------------------------------------------
      await this.gateStep(
        step,
        `gate-hitl2-${hitl2Iteration}`,
        runId,
        "hitl_2",
        "hitl.interrupted",
        { next: ["publish_or_revise"] },
      );
      const d2 = await step.waitForEvent<Hitl2Payload>(`await-hitl2-${hitl2Iteration}`, {
        type: "hitl_2",
        timeout: HITL_TIMEOUT,
      });
      const decision = d2.payload.decision;

      if (decision === "approve") {
        await this.statusStep(step, `status-publishing-${hitl2Iteration}`, runId, "publishing");
        await this.publish(runId, run, step);
        await step.do("compliance", async () =>
          this.withSql(async (sql) => {
            await writeComplianceLog(sql, runId, this.modelName());
            return "ok";
          }),
        );
        await this.emitStep(step, "emit-completed-approve", runId, "graph.completed", {});
        return;
      }

      if (decision === "reject") {
        await this.gateStep(step, "gate-rejected", runId, "rejected", "graph.completed", {});
        return;
      }

      // decision === "request_changes"
      if (hitl2Iteration >= MAX_HITL2_ROUNDS) {
        await this.gateStep(
          step,
          "gate-changes-requested",
          runId,
          "changes_requested",
          "graph.completed",
          {},
        );
        return;
      }

      // Reset the internal audit loop for a fresh revision round and re-enter
      // the production loop WITHOUT a second HITL_1 (mirrors production_revise,
      // which has no interrupt). Build refine notes from reviewer feedback.
      reviewerRefineNotes = buildReviewerRefineNotes(d2.payload);
      hitl2Iteration += 1;
      await this.statusStep(step, `status-revising-${hitl2Iteration}`, runId, "revising");
    }
  }

  // -------------------------------------------------------------------------
  // Refresh strategy preamble — fetch_article → gap_analysis → outline(refresh).
  // Mirrors content_tool/graph/strategy.py for start_mode="refresh". Returns the
  // run with chosen_route refreshed from the gap-analysis backfill so the
  // downstream production loop's writer sees the resolved route.
  // -------------------------------------------------------------------------

  private async runRefreshStrategy(
    runId: string,
    run: RunLoadRow,
    step: WorkflowStep,
    keywords: string[],
    todayDate: string,
  ): Promise<RunLoadRow> {
    const articleUrl = run.article_url;
    if (articleUrl === null || articleUrl === "") {
      throw new Error(`refresh run ${runId} has no article_url`);
    }

    // --- fetch_article (no LLM; idempotent on fetched_articles.run_id) ---
    await this.statusStep(step, "status-fetching", runId, "fetching");
    const fetched = await step.do("fetch-article", async () =>
      this.withSql<{ markdown: string }>(async (sql) => {
        const result = await runFetchArticle(sql, this.env, { runId, articleUrl });
        // Persist only what the outline needs — keep the step checkpoint small.
        return { markdown: result.markdown };
      }),
    );

    // --- gap_analysis (Gemini + googleSearch/urlContext; backfills chosen_route) ---
    await this.statusStep(step, "status-strategy-refresh", runId, "strategy");
    await step.do("gap-analysis", async () =>
      this.withSql(async (sql) => {
        const gemini = this.geminiClient(runId);
        await runGapAnalysis(sql, gemini, {
          runId,
          topic: run.topic,
          keywords,
          articleUrl,
          acfAdvId: run.acf_adv_id,
          acfWidgetId: run.acf_widget_id,
          mode: normalizeGapMode(run.mode),
          editNote: run.edit_note,
          todayDate,
          model: this.modelName(),
          thinkingLevel: DEFAULT_THINKING_LEVEL,
        });
        return "ok";
      }),
    );

    // --- outline (refresh): gap payload + existing markdown + chosen_route ---
    const chosenRoute = await step.do("outline", async () =>
      this.withSql<string>(async (sql) => {
        const gemini = this.geminiClient(runId);
        const gap = await this.loadGapPayload(sql, runId);
        await runOutline(sql, gemini, {
          runId,
          startMode: "refresh",
          topic: run.topic,
          keywords,
          targetAudience: run.target_audience,
          acfAdvId: run.acf_adv_id,
          acfWidgetId: run.acf_widget_id,
          editNote: run.edit_note,
          todayDate,
          gapAnalysisPayload: gap.payload,
          existingMarkdown: fetched.markdown,
          chosenRoute: gap.chosenRoute,
        });
        return gap.chosenRoute;
      }),
    );

    return { ...run, chosen_route: chosenRoute };
  }

  /** Load the gap-analysis payload (jsonb → object) + the backfilled chosen_route. */
  private async loadGapPayload(
    sql: ReturnType<typeof getSql>,
    runId: string,
  ): Promise<{ payload: object; chosenRoute: string }> {
    const gapRows = await sql<Array<{ payload: unknown }>>`
      SELECT payload FROM content_tool.gap_analyses WHERE run_id = ${runId}::uuid LIMIT 1
    `;
    const payload = (pgJson<object>(gapRows[0]?.payload) ?? {}) as object;
    const routeRows = await sql<Array<{ chosen_route: string | null }>>`
      SELECT chosen_route FROM content_tool.runs WHERE run_id = ${runId}::uuid LIMIT 1
    `;
    const chosenRoute = routeRows[0]?.chosen_route ?? "small_refresh";
    return { payload, chosenRoute };
  }

  // -------------------------------------------------------------------------
  // Production internal loop — writer → citations → render → audit, capped at
  // MAX_ITERATIONS, breaking on overall_pass. Mirrors build_production_graph.
  // -------------------------------------------------------------------------

  private async runProductionLoop(
    runId: string,
    run: RunLoadRow,
    step: WorkflowStep,
    hitl2Iteration: number,
    reviewerRefineNotes: RefineNote[] | null,
  ): Promise<void> {
    await this.statusStep(step, `status-production-${hitl2Iteration}`, runId, "production");

    let iteration = 0;
    // Tag every step name with the hitl-2 round so revision rounds get fresh,
    // non-colliding durable step ids (step ids must be unique per instance).
    const round = hitl2Iteration;

    for (;;) {
      // Refine notes = prior audit's high/must_fix findings (loop iteration > 0)
      // PLUS reviewer feedback (only on the FIRST pass of a revision round —
      // mirrors the Python writer reading hitl_2_comments when iteration === 0).
      const refineNotes = await this.buildRefineNotes(
        runId,
        iteration,
        iteration === 0 ? reviewerRefineNotes : null,
      );

      // --- writer ---
      const draftId = await step.do(`writer-${round}-${iteration}`, async () =>
        this.withSql<string>(async (sql) => {
          const gemini = this.geminiClient(runId);
          const result = await runWriter(sql, gemini, {
            run: {
              runId,
              topic: run.topic,
              keywords: toStringArray(run.keywords),
              articleUrl: run.article_url,
              acfAdvId: String(run.acf_adv_id),
              acfWidgetId: String(run.acf_widget_id),
              topicCategory: run.topic_category,
              persona: run.persona,
              startMode: run.start_mode,
              chosenRoute: run.chosen_route,
              editNote: run.edit_note,
            },
            outline: await this.loadOutline(sql, runId),
            refineNotes,
            iteration,
          });
          return result.draftId;
        }),
      );
      await this.emitStep(
        step,
        `emit-writer-done-${round}-${iteration}`,
        runId,
        "production.writer.done",
        {},
        iteration,
      );

      // --- resolve_citations ---
      await step.do(`resolve_citations-${round}-${iteration}`, async () =>
        this.withSql(async (sql) => {
          const draft = await this.loadDraftMarkup(sql, draftId);
          const groundingChunks = toGroundingChunks(draft.grounding_chunks);
          const { finalMarkup } = await resolveCitations(sql, {
            draftId,
            markupRaw: draft.markup_raw,
            groundingChunks,
            topicCategory: run.topic_category,
          });
          await sql`
            UPDATE content_tool.drafts
            SET final_markup = ${finalMarkup}
            WHERE draft_id = ${draftId}::uuid
          `;
          return "ok";
        }),
      );
      await this.emitStep(
        step,
        `emit-citations-done-${round}-${iteration}`,
        runId,
        "production.resolve_citations.done",
        {},
        iteration,
      );

      // --- render_html ---
      await step.do(`render-${round}-${iteration}`, async () =>
        this.withSql(async (sql) => {
          const finalMarkup = await this.loadFinalMarkup(sql, draftId);
          const render = renderHtml(finalMarkup);
          // DELETE-then-INSERT keeps single-row semantics across loop replays
          // (renders.draft_id has no UNIQUE in the baseline, so guard manually).
          await sql`DELETE FROM content_tool.renders WHERE draft_id = ${draftId}::uuid`;
          await sql`
            INSERT INTO content_tool.renders (
              render_id, draft_id, seo_title, meta_description, html_body,
              faq_schema_jsonld, schema_jsonld, excerpt_suggestion, slug_suggestion
            ) VALUES (
              gen_random_uuid(),
              ${draftId}::uuid,
              ${render.seoTitle},
              ${render.metaDescription},
              ${render.htmlBody},
              ${render.faqSchemaJsonld === null ? null : toJsonb(sql, render.faqSchemaJsonld)},
              ${render.schemaJsonld === null ? null : toJsonb(sql, render.schemaJsonld)},
              ${render.excerptSuggestion},
              ${render.slugSuggestion}
            )
          `;
          return "ok";
        }),
      );
      await this.emitStep(
        step,
        `emit-render-done-${round}-${iteration}`,
        runId,
        "production.render_html.done",
        {},
        iteration,
      );

      // --- audit ---
      const overallPass = await step.do(`audit-${round}-${iteration}`, async () =>
        this.withSql<boolean>(async (sql) => {
          const gemini = this.geminiClient(runId);
          const render = await this.loadRenderForAudit(sql, draftId);
          const citationIntents = toObjectArray(
            (await this.loadDraftMarkup(sql, draftId)).citation_intents,
          );
          const citationsSummary = await this.loadCitationsSummary(sql, draftId);
          const citationsDeniedDisplayed = await this.anyDeniedDisplayed(sql, draftId);
          const { audit } = await runAudit(sql, gemini, {
            run: { runId, persona: run.persona },
            draftId,
            htmlBody: render.html_body,
            citationIntents,
            citationsSummary,
            schemaJsonld: toObjectArrayOrNull(render.schema_jsonld),
            citationsDeniedDisplayed,
            advEnabled: run.acf_adv_id !== 0,
            widgetEnabled: run.acf_widget_id !== 0,
            todayDate: run.today_date.slice(0, 10),
          });
          return audit.overall_pass;
        }),
      );
      await this.emitStep(
        step,
        `emit-audit-done-${round}-${iteration}`,
        runId,
        "production.audit.done",
        {},
        iteration,
      );

      // Break on a clean audit OR after exhausting the internal budget
      // (route_after_audit: END when overall_pass or iteration >= MAX-1).
      if (overallPass || iteration >= MAX_ITERATIONS - 1) {
        return;
      }
      iteration += 1;
    }
  }

  // -------------------------------------------------------------------------
  // HITL_1 application — returns true when the run was cancelled (terminal).
  // -------------------------------------------------------------------------

  private async applyHitl1(runId: string, payload: Hitl1Payload): Promise<boolean> {
    return this.withSql<boolean>(async (sql) => {
      const decision = payload.decision;

      if (decision === "cancel") {
        await sql`
          UPDATE content_tool.runs
          SET status = 'changes_requested', hitl_1_decision = ${decision},
              hitl_1_notes = ${payload.notes ?? null}
          WHERE run_id = ${runId}::uuid
        `;
        return true;
      }

      if (decision === "edit_outline" && payload.edited_outline) {
        const edited = payload.edited_outline;
        // Replace the outline payload AND record the human edit (mirrors the
        // resume route writing outlines.human_edits + edited_by_human).
        await sql`
          UPDATE content_tool.outlines
          SET payload = ${toJsonb(sql, edited)},
              edited_by_human = ${true},
              human_edits = ${toJsonb(sql, edited)}
          WHERE run_id = ${runId}::uuid
        `;
      }

      if (decision === "override_route" && payload.new_route) {
        await sql`
          UPDATE content_tool.runs
          SET chosen_route = ${payload.new_route}
          WHERE run_id = ${runId}::uuid
        `;
      }

      await sql`
        UPDATE content_tool.runs
        SET hitl_1_decision = ${decision}, hitl_1_notes = ${payload.notes ?? null}
        WHERE run_id = ${runId}::uuid
      `;
      return false;
    });
  }

  // -------------------------------------------------------------------------
  // Publish — WP upsert + run-row backfill. Mirrors publish_to_wordpress for
  // both modes: create mints a brand-new post (article_url backfilled to the new
  // link); refresh UPDATEs the existing post (id from fetched_articles,
  // article_url preserved). Both modes honor the operator's status choice
  // (default "draft") — see resolvePublishStatus.
  // -------------------------------------------------------------------------

  private async publish(runId: string, run: RunLoadRow, step: WorkflowStep): Promise<void> {
    const isRefresh = run.start_mode === "refresh";

    // SEO plugin detection is a network probe — its own durable step.
    const seoPlugin = await step.do("detect-seo", async () =>
      detectSeoPlugin(this.env),
    );

    await step.do("publish", async () =>
      this.withSql(async (sql) => {
        const hitl2 = await this.loadHitl2Options(sql, runId);
        const draftId = await this.loadLatestDraftId(sql, runId);
        const render = await this.loadRenderForAudit(sql, draftId);

        const meta = buildMeta(
          render.meta_description,
          toObjectArrayOrNull(render.schema_jsonld),
          seoPlugin as SeoPlugin | null,
        );

        // Resolve the target post id. Refresh updates the existing post (from
        // fetched_articles) unless a prior push already recorded an id. Create
        // reuses wp_pushed_post_id on a re-push, else mints a new draft (null).
        const postId = isRefresh
          ? (run.wp_pushed_post_id ?? (await this.loadFetchedPostId(sql, runId)))
          : run.wp_pushed_post_id;

        // Honor the operator's status choice for both create and refresh runs
        // (defaulting to draft) so a "publish" selection is never silently
        // demoted to a draft.
        const status = resolvePublishStatus(hitl2.wp_publish_status);

        const payload: PublishPayload = {
          postId,
          title: render.seo_title,
          content: render.html_body,
          excerpt: hitl2.wp_excerpt || (render.excerpt_suggestion ?? ""),
          status,
          slug: hitl2.wp_slug,
          categories: toNumberArray(hitl2.wp_category_ids),
          tags: toNumberArray(hitl2.wp_tag_ids),
          author: hitl2.wp_author_id,
          featuredMedia: hitl2.wp_featured_media_id,
          meta,
          ifUnmodifiedSince: null,
          dateGmt: null,
          template: WP_DEFAULT_PAGE_TEMPLATE,
        };

        const wpClient = new WordPressClient(this.env);
        const result = await wpClient.upsert(payload);

        // Backfill the WP post id + flip to published. Create surfaces the freshly
        // minted draft URL on the run row; refresh keeps the canonical article_url.
        if (isRefresh) {
          await sql`
            UPDATE content_tool.runs
            SET wp_pushed_post_id = ${result.id},
                wp_pushed_at = now(),
                status = 'published'
            WHERE run_id = ${runId}::uuid
          `;
          // Stamp the inventory article's last_persisted_at so the refresh
          // scanner's staleness reference tracks the republish instead of
          // drifting off first_seen_at (mirrors publish.py). No-op if the URL
          // isn't in the inventory.
          if (run.article_url !== null && run.article_url !== "") {
            await sql`
              UPDATE content_tool.articles
              SET last_persisted_at = now()
              WHERE article_url = ${run.article_url}
            `;
          }
        } else {
          await sql`
            UPDATE content_tool.runs
            SET wp_pushed_post_id = ${result.id},
                wp_pushed_at = now(),
                status = 'published',
                article_url = ${result.link}
            WHERE run_id = ${runId}::uuid
          `;
        }
        return "ok";
      }),
    );
  }

  /** Existing WP post id captured by fetch_article (refresh target). */
  private async loadFetchedPostId(
    sql: ReturnType<typeof getSql>,
    runId: string,
  ): Promise<number | null> {
    const rows = await sql<Array<{ wp_post_id: number | null }>>`
      SELECT wp_post_id FROM content_tool.fetched_articles
      WHERE run_id = ${runId}::uuid LIMIT 1
    `;
    return rows[0]?.wp_post_id ?? null;
  }

  // -------------------------------------------------------------------------
  // Refine-note assembly — prior audit high/must_fix findings (+ reviewer
  // notes on the first pass of a revision round). Mirrors n_writer in
  // content_tool/graph/production.py.
  // -------------------------------------------------------------------------

  private async buildRefineNotes(
    runId: string,
    iteration: number,
    reviewerRefineNotes: RefineNote[] | null,
  ): Promise<RefineNote[] | null> {
    const notes: RefineNote[] = [];

    if (iteration > 0) {
      const findings = await this.loadLatestAuditFindings(runId);
      for (const f of findings) {
        if (f.must_fix === true || f.severity === "high") {
          notes.push(f as RefineNote);
        }
      }
    }

    if (reviewerRefineNotes) {
      notes.push(...reviewerRefineNotes);
    }

    return notes.length > 0 ? notes : null;
  }

  // -------------------------------------------------------------------------
  // DB read helpers — each opens its own connection inside the calling step.
  // -------------------------------------------------------------------------

  private async loadOutline(sql: ReturnType<typeof getSql>, runId: string): Promise<object> {
    const rows = await sql<OutlinePayloadRow[]>`
      SELECT payload FROM content_tool.outlines WHERE run_id = ${runId}::uuid LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`outline not found for run ${runId}`);
    }
    return (row.payload ?? {}) as object;
  }

  private async loadDraftMarkup(
    sql: ReturnType<typeof getSql>,
    draftId: string,
  ): Promise<DraftMarkupRow> {
    const rows = await sql<DraftMarkupRow[]>`
      SELECT draft_id, markup_raw, grounding_chunks, citation_intents
      FROM content_tool.drafts WHERE draft_id = ${draftId}::uuid LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`draft not found: ${draftId}`);
    }
    return row;
  }

  private async loadFinalMarkup(
    sql: ReturnType<typeof getSql>,
    draftId: string,
  ): Promise<string> {
    const rows = await sql<RenderInputRow[]>`
      SELECT final_markup FROM content_tool.drafts WHERE draft_id = ${draftId}::uuid LIMIT 1
    `;
    const markup = rows[0]?.final_markup;
    if (markup === null || markup === undefined) {
      throw new Error(`final_markup not set for draft ${draftId}`);
    }
    return markup;
  }

  private async loadRenderForAudit(
    sql: ReturnType<typeof getSql>,
    draftId: string,
  ): Promise<RenderRowForPublish> {
    const rows = await sql<RenderRowForPublish[]>`
      SELECT seo_title, meta_description, html_body, schema_jsonld, excerpt_suggestion
      FROM content_tool.renders WHERE draft_id = ${draftId}::uuid LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`render not found for draft ${draftId}`);
    }
    return row;
  }

  private async loadCitationsSummary(
    sql: ReturnType<typeof getSql>,
    draftId: string,
  ): Promise<object[]> {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT domain, final_url, title, policy_decision, was_displayed
      FROM content_tool.citations WHERE draft_id = ${draftId}::uuid
      ORDER BY chunk_idx ASC
    `;
    return rows;
  }

  private async anyDeniedDisplayed(
    sql: ReturnType<typeof getSql>,
    draftId: string,
  ): Promise<boolean> {
    const rows = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM content_tool.citations
      WHERE draft_id = ${draftId}::uuid
        AND was_displayed = true AND policy_decision = 'denied'
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  private async loadLatestAuditFindings(runId: string): Promise<AuditFindingLike[]> {
    return this.withSql<AuditFindingLike[]>(async (sql) => {
      const rows = await sql<Array<{ llm_findings: unknown; deterministic_findings: unknown }>>`
        SELECT ar.llm_findings, ar.deterministic_findings
        FROM content_tool.audit_runs ar
        JOIN content_tool.drafts d ON d.draft_id = ar.draft_id
        WHERE d.run_id = ${runId}::uuid
        ORDER BY d.iteration DESC
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) {
        return [];
      }
      return [
        ...extractFindings(row.llm_findings),
        ...extractFindings(row.deterministic_findings),
      ];
    });
  }

  private async loadLatestDraftId(
    sql: ReturnType<typeof getSql>,
    runId: string,
  ): Promise<string> {
    const rows = await sql<Array<{ draft_id: string }>>`
      SELECT draft_id FROM content_tool.drafts
      WHERE run_id = ${runId}::uuid ORDER BY iteration DESC LIMIT 1
    `;
    const draftId = rows[0]?.draft_id;
    if (draftId === undefined) {
      throw new Error(`no draft for run ${runId}`);
    }
    return draftId;
  }

  private async loadHitl2Options(
    sql: ReturnType<typeof getSql>,
    runId: string,
  ): Promise<Hitl2PersistRow> {
    const rows = await sql<Hitl2PersistRow[]>`
      SELECT hitl_2_iteration, wp_publish_status, wp_author_id, wp_category_ids,
             wp_tag_ids, wp_featured_media_id, wp_slug, wp_excerpt
      FROM content_tool.runs WHERE run_id = ${runId}::uuid LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`run not found: ${runId}`);
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // SSE emit + status persistence + connection + Gemini client helpers.
  // -------------------------------------------------------------------------

  /**
   * Emit one event into the per-run RUN_STREAM Durable Object. Envelope mirrors
   * RunExecutor._emit EXACTLY: { event, run_id, timestamp (ISO+Z), payload } —
   * plus the optional `iteration` field threaded by the production loop.
   */
  private async emit(
    runId: string,
    eventName: string,
    payload: Record<string, unknown>,
    iteration?: number,
  ): Promise<void> {
    const envelope: Record<string, unknown> = {
      event: eventName,
      run_id: runId,
      timestamp: isoZ(),
      payload,
    };
    if (iteration !== undefined) {
      envelope["iteration"] = iteration;
    }
    await this.env.RUN_STREAM.get(this.env.RUN_STREAM.idFromName(runId)).fetch(
      "https://run-stream/append",
      { method: "POST", body: JSON.stringify(envelope) },
    );
  }

  private async setStatus(runId: string, status: string): Promise<void> {
    await this.withSql(async (sql) => {
      await sql`
        UPDATE content_tool.runs SET status = ${status} WHERE run_id = ${runId}::uuid
      `;
      return undefined;
    });
  }

  // -------------------------------------------------------------------------
  // Durable side-effect wrappers. On a Cloudflare Workflows replay (after a
  // hibernation wake at waitForEvent), the run() body re-executes from the top;
  // only completed step.do() callbacks are memoized. A bare setStatus/emit
  // therefore re-fires on every wake → duplicate status writes + duplicate SSE
  // timeline events. Wrapping each in a named step makes it run exactly once
  // (the emit's timestamp is also stamped once). Every `label` MUST be unique
  // per workflow instance.
  // -------------------------------------------------------------------------

  private async statusStep(
    step: WorkflowStep,
    label: string,
    runId: string,
    status: string,
  ): Promise<void> {
    await step.do(label, async () => {
      await this.setStatus(runId, status);
      return "ok";
    });
  }

  private async emitStep(
    step: WorkflowStep,
    label: string,
    runId: string,
    eventName: string,
    payload: Record<string, unknown>,
    iteration?: number,
  ): Promise<void> {
    await step.do(label, async () => {
      await this.emit(runId, eventName, payload, iteration);
      return "ok";
    });
  }

  /** Set a status AND emit one event atomically in a single named step — used for
   * the HITL interrupts and terminal states so neither side effect re-fires on a
   * resume after hibernation. */
  private async gateStep(
    step: WorkflowStep,
    label: string,
    runId: string,
    status: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await step.do(label, async () => {
      await this.setStatus(runId, status);
      await this.emit(runId, eventName, payload);
      return "ok";
    });
  }

  /** Open a short-lived connection, run `fn`, and close the socket afterwards. */
  private async withSql<T>(fn: (sql: ReturnType<typeof getSql>) => Promise<T>): Promise<T> {
    const sql = getSql(this.env);
    try {
      return await fn(sql);
    } finally {
      await sql.end().catch(() => undefined);
    }
  }

  private geminiClient(runId: string): GeminiClient {
    // Route through the US-pinned GeminiProxy DO: a direct call from this colo
    // (Asia/HK) is geo-blocked by Google AI Studio. DoGeminiClient forwards to a
    // DO obtained with locationHint "enam", which egresses a US IP.
    //
    // `runId` enables live thought streaming: the proxy POSTs each thought chunk
    // to this run's RUN_STREAM hub as a `{agent}.thinking` event, so the UI's
    // "Model thinking" panel fills in during long steps (matches the Python
    // backend's in-process emitter).
    return new DoGeminiClient(this.env.GEMINI_PROXY, {
      model: this.modelName(),
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      runId,
    });
  }

  private modelName(): string {
    return this.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (module-level — no `this`).
// ---------------------------------------------------------------------------

/**
 * Build reviewer refine notes from a request_changes HITL_2 payload. Mirrors
 * the Python n_writer reviewer-note shape EXACTLY:
 *   per comment: { source:"reviewer", severity:"high", must_fix:true,
 *                  issue: 'On span "<anchor_text>": <comment>' }
 *   overall:     { ...same..., issue: 'Overall reviewer note: <notes>' }
 */
function buildReviewerRefineNotes(payload: Hitl2Payload): RefineNote[] {
  const notes: RefineNote[] = [];
  for (const c of payload.comments ?? []) {
    notes.push({
      source: "reviewer",
      severity: "high",
      must_fix: true,
      issue: `On span "${c.anchor_text}": ${c.comment}`,
    });
  }
  if (payload.notes) {
    notes.push({
      source: "reviewer",
      severity: "high",
      must_fix: true,
      issue: `Overall reviewer note: ${payload.notes}`,
    });
  }
  return notes;
}

/** Current time as an ISO-8601 string with a trailing "Z" (mirrors Python). */
function isoZ(): string {
  // Python emits `datetime.utcnow().isoformat() + "Z"` — a naive ISO string with
  // an appended Z. Date.toISOString() already ends in Z, so use it directly.
  return new Date().toISOString();
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

/** Narrow the free-form runs.mode to the gap-analysis route-override enum. */
function normalizeGapMode(mode: string): "auto" | "small_refresh" | "full_rewrite" {
  return mode === "small_refresh" || mode === "full_rewrite" ? mode : "auto";
}

function toStringArray(value: unknown): string[] {
  // `getSql` sets `fetch_types: false`, so postgres.js has no OID→parser map and
  // returns JSONB columns as the RAW text it received (e.g. '["kw1","kw2"]')
  // instead of a parsed JS array. Parse a string form before the array check so
  // `keywords` round-trips into the loaded run state instead of collapsing to [].
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((v): v is string => typeof v === "string");
}

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === "number");
}

function toObjectArray(value: unknown): object[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is object => typeof v === "object" && v !== null);
}

function toObjectArrayOrNull(value: unknown): object[] | null {
  if (!Array.isArray(value)) return null;
  const arr = toObjectArray(value);
  return arr.length > 0 ? arr : null;
}

function toGroundingChunks(value: unknown): GroundingChunk[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is GroundingChunk => typeof v === "object" && v !== null);
}

/** Unwrap `{ findings: [...] }` (the audit_runs JSONB shape) into a flat array. */
function extractFindings(value: unknown): AuditFindingLike[] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const findings = (value as Record<string, unknown>)["findings"];
    if (Array.isArray(findings)) {
      return findings.filter((f): f is AuditFindingLike => typeof f === "object" && f !== null);
    }
  }
  if (Array.isArray(value)) {
    return value.filter((f): f is AuditFindingLike => typeof f === "object" && f !== null);
  }
  return [];
}
