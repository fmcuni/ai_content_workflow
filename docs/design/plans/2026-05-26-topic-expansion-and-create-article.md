# Topic Expansion & New-Article Creation — Implementation Plan

**Goal:** Turn on Front II ("Expand Topics") and Front III ("Create New Articles") at `/runs/new`. Front II takes a research-theme brief and produces a vetted batch of topic candidates (theme → topic-gen → dedup + hot-topic SERP analysis → HITL_T1 review → fan-out to runs). Front III is a single-topic create-mode run with no theme/batch overhead. Both flows reuse the existing outline → HITL_1 → writer → audit → HITL_2 → publish pipeline via a new `start_mode = "create"` switch; create-mode runs publish to WordPress as **drafts**, not live posts.

**Architecture:**

- Two new Postgres tables: `topic_batches` (parent brief + lifecycle status) and `topic_candidates` (one row per generated topic with dedup + hot-topic verdicts and a `promoted_run_id` once commissioned).
- One new LangGraph subgraph `topic_expansion` (`topic_gen → fan_out → [dedup, hot_topic]×N parallel → aggregate`). No interrupt inside — HITL_T1 is "graph completes → operator reviews → `/promote` API call."
- Existing production subgraph gets a `start_mode` branch at `strategy`: in create mode skip `fetch_article` + `gap_analysis` and jump straight to `outline`. `outline` agent picks between the existing refresh prompt and the n8n create-mode prompt via a `{create_mode_block}` substitution.
- Three new agents: `topic_gen`, `topic_dedup`, `topic_hot`. Three new prompt files. One new FastAPI router (`topic_batches`). Existing `POST /runs` accepts `start_mode` + `topic_candidate_id`.
- WP publishing in create mode: `publish.py` passes `post_id=None, status="draft"` to the existing `WordPressClient.upsert()` (no client changes needed).
- Two new Next.js routes: `/runs/new?front=topics` (brief form), `/topic-batches/[id]` (live progress + HITL_T1 review grid). Front I and Front III share the existing Ledger component; Front III hides the `article_url` column.

**Tech Stack:** Python 3.13, FastAPI, LangGraph, SQLAlchemy (async) + Alembic, PostgreSQL, Pydantic v2, asyncpg, sse-starlette, pytest + pytest-asyncio + testcontainers; Next.js (custom — see [web/AGENTS.md](../../../web/AGENTS.md) — read `node_modules/next/dist/docs/` before touching framework APIs), React 19, React Query (`@tanstack/react-query`), TypeScript, Tailwind 4, the project's existing `ui/*` primitives.

**Spec:** [docs/design/specs/2026-05-26-topic-expansion-and-create-article-design.md](../specs/2026-05-26-topic-expansion-and-create-article-design.md)

**Reference workflow:** `~/Downloads/AI Content Creation - 1) Create article (1).json` (n8n). Prompts in the n8n nodes are the source of truth for the four new prompt files; copy them verbatim where the spec says "verbatim."

---

## File map

**Backend — DB & migrations**

- Create `migrations/versions/0013_topic_batches.py` — `topic_batches` + `topic_candidates` tables, plus `start_mode`, `topic_candidate_id`, `target_audience` columns on `runs`; backfill `start_mode = 'refresh'`; drop NOT NULL on `runs.article_url`.
- Create `content_tool/db/topic_batch_model.py` — `TopicBatch`, `TopicCandidate` SQLAlchemy models (kept out of `db/models.py` per the project pattern set by `persona_model.py`).
- Modify `content_tool/db/models.py` — re-export `TopicBatch`, `TopicCandidate`; add the three new columns to the `Run` model.

**Backend — agents & graph**

- Create `prompts/topic_gen.md` — n8n topic-gen system prompt verbatim.
- Create `prompts/topic_dedup.md` — n8n dedup prompt rewritten for one topic per call.
- Create `prompts/topic_hot.md` — n8n hot-topic prompt rewritten for one topic per call.
- Modify `prompts/outline.md` — add `{create_mode_block}` substitution carrying the n8n outline prompt body.
- Create `content_tool/agents/topic_gen.py` — one Gemini call, JSON schema, grounding + URL context on.
- Create `content_tool/agents/topic_dedup.py` — one Gemini call per candidate.
- Create `content_tool/agents/topic_hot.py` — one Gemini call per candidate.
- Modify `content_tool/agents/outline.py` — branch on `state.start_mode`; pick prompt body accordingly.
- Modify `content_tool/agents/publish.py` — in create mode, set `post_id=None, status="draft"`; backfill `runs.article_url` from the draft link returned.
- Create `content_tool/graph/topic_expansion.py` — the new subgraph + checkpointer wiring.
- Modify `content_tool/graph/root.py` — add `start_mode` branch at entry to strategy; route to `outline` directly when `start_mode == "create"`.
- Modify `content_tool/graph/strategy.py` — accept being entered at `outline` (no-op if `fetch_article` and `gap_analysis` already skipped).
- Modify `content_tool/models/` (state types) — add `start_mode`, `topic_candidate_id`, `target_audience` to the run state TypedDict.

**Backend — API**

- Modify `content_tool/api/schemas.py` — `TopicBatchIn`, `TopicBatchOut`, `TopicCandidateOut`, `PromoteRequest`, `PromoteResponse`. Extend `CreateRunRequest` with `start_mode`, `topic_candidate_id`, optional `article_url`, optional `target_audience`.
- Create `content_tool/api/routes/topic_batches.py` — CRUD + SSE + promote + skip + close.
- Modify `content_tool/api/routes/runs.py` — accept `start_mode` and `topic_candidate_id`; validate `article_url` is present in refresh mode and absent in create mode; when create, dispatch via the new graph entry path.
- Modify `content_tool/api/main.py` — `include_router(topic_batches)`.
- Modify `content_tool/api/sse.py` (the existing `RunExecutor`) only if needed to support the `start_mode` branch.

**Web**

- Modify `web/lib/types.ts` — `TopicBatch`, `TopicCandidate`, `BatchStatus`, `CandidateStatus`, extend `CreateRunRequest` with `start_mode`, `topic_candidate_id`.
- Modify `web/lib/api.ts` — `topicBatchesApi` (`create`, `list`, `detail`, `events`, `patchCandidate`, `promote`, `skip`, `close`).
- Modify `web/app/runs/new/page.tsx` — flip Front II + Front III to `active: true`; render `<BriefForm/>` when `front === "topics"` and `<CreateLedger/>` when `front === "create"`. Keep existing Ledger as the Front I view.
- Create `web/components/topics/BriefForm.tsx` — the brief sheet for Front II.
- Create `web/app/topic-batches/[id]/page.tsx` — progress + HITL_T1 review.
- Create `web/components/topics/BatchProgress.tsx` — SSE-driven progress strip + live candidate grid.
- Create `web/components/topics/CandidateGrid.tsx` — sticky-header sheet view + commission checkboxes + inline edit + two-badge verdict.
- Create `web/components/topics/VerdictBadge.tsx` — the dedup / hot-topic stamp component.
- Modify `web/components/Masthead.tsx` — optional new nav entry "Briefs" linking to `/topic-batches` (list view) once that lists view exists; defer if not needed in v1.
- Modify `web/app/runs/[runId]/page.tsx` — show a "From brief #N" breadcrumb when `run.topic_candidate_id != null`.

**Tests**

- Create `tests/unit/test_topic_gen_agent.py` — schema, prompt substitution, error handling.
- Create `tests/unit/test_topic_dedup_agent.py` — schema, per-candidate isolation.
- Create `tests/unit/test_topic_hot_agent.py` — schema.
- Create `tests/unit/test_outline_create_mode.py` — assert `{create_mode_block}` swap behaviour.
- Create `tests/integration/test_topic_expansion_graph.py` — full subgraph run against a mocked Gemini.
- Create `tests/integration/test_api_topic_batches.py` — POST/GET/PATCH/promote/skip/close lifecycle.
- Create `tests/integration/test_run_create_mode.py` — end-to-end create-mode run (mocked Gemini, real WP client stubbed) — verifies draft publishing.
- Modify `tests/integration/test_api_runs.py` — extend with `start_mode` cases.
- Create `web/__tests__/CandidateGrid.test.tsx` — promote-checkbox defaults, commission button counter, badge expansion (using whichever React testing setup the project already uses).

---

## Task 1: Migration + DB models

- [ ] Create `migrations/versions/0013_topic_batches.py` that:
  - creates `topic_batches` (UUID PK, all spec fields, `status` text, `created_at`/`updated_at` server defaults, `cost_cents` int default 0)
  - creates `topic_candidates` (UUID PK, FK to `topic_batches.id` with `ON DELETE CASCADE`, `keywords` as JSONB, plus the edit-history fields `original_topic text not null`, `original_keywords jsonb not null`, `last_edited_by text null`, `last_edited_at timestamptz null`, plus `promote_mode text null`, `last_error text null`, and `promoted_run_id` FK to `runs.id` nullable)
  - adds to `runs`: `start_mode text not null default 'refresh'`, `topic_candidate_id uuid null`, `target_audience text null`; drops `NOT NULL` from `runs.article_url`
  - backfills existing rows with `start_mode = 'refresh'`
  - indexes: `topic_candidates(batch_id)`, `topic_candidates(promoted_run_id)`, `runs(topic_candidate_id)`
- [ ] Create `content_tool/db/topic_batch_model.py` with `TopicBatch` and `TopicCandidate` ORM classes, type-annotated per the project's strict-pyright baseline ([CLAUDE.md](../../../CLAUDE.md)).
- [ ] Re-export both from `content_tool/db/models.py`.
- [ ] Extend `Run` ORM with `start_mode`, `topic_candidate_id`, `target_audience`.
- [ ] Run `alembic upgrade head` against the local dev DB; capture the diff.
- [ ] Verify `pyright` is clean on the new files (do not weaken config; aim to add 0 new errors in touched files per the project's ratchet rule).

## Task 2: New prompts + agents

- [ ] Copy the n8n topic-gen system prompt (n8n node `Settings`, position `[7104, 496]`) verbatim into `prompts/topic_gen.md`; preserve the `{research_theme}`, `{target_audience}`, `{topic_count}`, `{keywords_per_topic}`, `{must_cover}`, `{must_avoid}`, `{priority_focus}`, `{notes}` placeholders for the user prompt.
- [ ] Adapt the n8n dedup prompt (`Settings1`) for one-topic-per-call into `prompts/topic_dedup.md`. User prompt placeholders: `{topic}`, `{keywords}`. Response schema enforced from the agent, not the prompt.
- [ ] Adapt the n8n hot-topic prompt (`Settings2`) similarly into `prompts/topic_hot.md`.
- [ ] Modify `prompts/outline.md` to include a `{create_mode_block}` substitution. When `start_mode == "create"`, the block contains the n8n outline prompt body (`Settings3`). When `start_mode == "refresh"`, the block contains the existing gap-analysis-driven instructions.
- [ ] Create `content_tool/agents/topic_gen.py` — async function `run_topic_gen(state, gemini)`; loads prompt, formats placeholders, calls Gemini with `responseJsonSchema = {topics: [{topic, keywords[]}]}`, `temperature=1.0`, `tools=[googleSearch, urlContext]`; returns parsed candidates list. Mirror the structure of `content_tool/agents/writer.py`.
- [ ] Create `content_tool/agents/topic_dedup.py` — async function `analyse_candidate_dedup(candidate, gemini)`; same Gemini call shape, returns `{existing, existing_note, existing_url}`. Add a 2-attempt retry with exponential backoff matching how `writer.py` handles transient Gemini errors.
- [ ] Create `content_tool/agents/topic_hot.py` — same shape, returns `{hot_topic, hot_topic_note}`.
- [ ] Unit tests: `tests/unit/test_topic_gen_agent.py`, `tests/unit/test_topic_dedup_agent.py`, `tests/unit/test_topic_hot_agent.py`. Use the existing Gemini stub pattern from `tests/unit/test_writer.py` (or equivalent) — do not hit the live API.

## Task 3: Topic-expansion subgraph

- [ ] Create `content_tool/graph/topic_expansion.py`:
  - Nodes: `topic_gen`, `fan_out`, `analyse_candidate` (single function, invoked per candidate via a `Send`/map-reduce pattern), `aggregate`.
  - `topic_gen` writes `topic_batches.status = 'generating'` on entry, calls `agents.topic_gen.run_topic_gen`, persists raw response, writes `topic_batches.status = 'analysing'` on exit.
  - `fan_out` inserts a `topic_candidates` row per generated topic in `status='candidate'`, then emits `Send("analyse_candidate", {candidate_id})` for each.
  - `analyse_candidate` acquires the shared `asyncio.Semaphore(5)` (constructed in the graph factory, scoped to the run) and runs `analyse_candidate_dedup` + `analyse_candidate_hot` concurrently with `asyncio.gather`; writes both verdicts back to the candidate row. On failure: 2 retries with backoff, then mark the candidate with `existing=NULL` / `hot_topic=NULL` and record the error.
  - `aggregate` waits for all candidates to settle, then flips `topic_batches.status = 'ready_for_review'`.
- [ ] Wire into the existing checkpointer (`content_tool/graph/checkpointer.py`) so SSE can stream candidate-row updates.
- [ ] Integration test `tests/integration/test_topic_expansion_graph.py` — drive the graph end-to-end with stubbed Gemini, assert 10 candidates land, batch status transitions are correct, partial failures don't bring down the batch.

## Task 4: `start_mode` on the production pipeline

- [ ] Extend the run state TypedDict (`content_tool/models/`) with `start_mode: Literal["refresh", "create"]`, `topic_candidate_id: UUID | None`, `target_audience: str | None`.
- [ ] In `content_tool/graph/root.py`, branch at the strategy entry: when `start_mode == "create"`, route to `outline` directly (no `fetch_article`, no `gap_analysis`); otherwise keep today's path. Use a conditional edge rather than a separate subgraph to keep diff small.
- [ ] In `content_tool/agents/outline.py`, branch the prompt body on `state.start_mode` via the new `{create_mode_block}` substitution.
- [ ] In `content_tool/agents/publish.py`, in create mode pass `post_id=None` and `status="draft"` to `WordPressClient.upsert()`. Backfill `state.article_url` (and the `runs` row) with the returned draft `link`. Refresh-mode behaviour unchanged.
- [ ] Verify `content_tool/agents/audit.py` handles an empty `gap_analysis_findings` cleanly (it should already, since refresh-with-no-diff is a real case). Add a unit test if not.
- [ ] Unit test `tests/unit/test_outline_create_mode.py` — assert the `{create_mode_block}` swap.
- [ ] Integration test `tests/integration/test_run_create_mode.py` — full graph with stubbed Gemini + stubbed WP; verify draft publish call shape (`post_id is None`, `status == "draft"`).

## Task 5: API — topic batches router

- [ ] Add Pydantic schemas to `content_tool/api/schemas.py`: `TopicBatchIn`, `TopicBatchOut`, `TopicCandidateOut`, `PatchCandidateIn`, `PromoteRequest` (with `candidate_ids: list[UUID]`), `PromoteResponseItem`.
- [ ] Create `content_tool/api/routes/topic_batches.py`:
  - `POST /topic-batches` — insert row, kick off `topic_expansion` graph in the background (`RunExecutor`-style task), return `{id, status}`.
  - `GET /topic-batches` — paginated list, optional `status` filter.
  - `GET /topic-batches/{id}` — detail with candidates ordered by `position`.
  - `GET /topic-batches/{id}/events` — `sse-starlette` stream of batch + candidate updates; reuse the SSE patterns from `api/sse.py`.
  - `PATCH /topic-batches/{id}/candidates/{cid}` — body `{topic?, keywords?, persona_slug?, acf_adv_id?, acf_widget_id?, operator_note?}`. Reject if batch status is `done`/`failed`.
  - `POST /topic-batches/{id}/promote` — body `{promotions: [{candidate_id, mode: "create" | "refresh"}]}`. For each promotion:
    - `create` mode: dispatch `POST /runs` with `start_mode="create"`, `topic_candidate_id=cid`, `topic`, `keywords`, `persona`, `acf_adv_id`, `acf_widget_id`, `target_audience` (from batch).
    - `refresh` mode: validate the candidate's `existing_url` is non-empty (reject the whole request with 422 if any refresh promotion has a blank URL); dispatch `POST /runs` with `start_mode="refresh"`, `article_url=candidate.existing_url`, `topic_candidate_id=cid`, plus the same topic/keywords/persona/ACF fields.
    Update each candidate's `promoted_run_id`, `promote_mode`, and `status="promoted"`. Update batch status to `partially_promoted` (or `done` if every candidate is now either `promoted` or `skipped`). Return `[{candidate_id, run_id, mode}, ...]`.
  - `POST /topic-batches/{id}/candidates/{cid}/skip`.
  - `POST /topic-batches/{id}/close` — explicit operator close.
- [ ] Wire into `content_tool/api/main.py`.
- [ ] Extend `POST /runs` in `content_tool/api/routes/runs.py` to accept `start_mode` and `topic_candidate_id`. Validate: in `refresh` mode `article_url` required; in `create` mode `article_url` MUST be absent (server-generated after draft).
- [ ] Integration test `tests/integration/test_api_topic_batches.py` — full POST → SSE → PATCH → promote → close lifecycle, plus error paths (promote on `failed` batch rejected, etc.).
- [ ] Extend `tests/integration/test_api_runs.py` with `start_mode="create"` cases.

## Task 6: Web — Front II brief form

- [ ] Add types to `web/lib/types.ts`: `TopicBatch`, `TopicCandidate`, `BatchStatus`, `CandidateStatus`, extend `CreateRunRequest`.
- [ ] Add `topicBatchesApi` to `web/lib/api.ts`: `create`, `list`, `detail`, `events` (EventSource wrapper matching the project's existing SSE helper), `patchCandidate`, `promote`, `skip`, `close`.
- [ ] In `web/app/runs/new/page.tsx`, mark `front: "topics"` and `front: "create"` as `active: true` in the `FRONTS` constant.
- [ ] Render different bodies based on `front`:
  - `front === "articles"` → existing Ledger (no change).
  - `front === "topics"` → new `<BriefForm/>`.
  - `front === "create"` → new `<CreateLedger/>` (a thin wrapper around `LedgerRowView` with `article_url` cell omitted, mode pinned to `auto`).
- [ ] Create `web/components/topics/BriefForm.tsx`:
  - Single-column brief sheet; styles consistent with the broadsheet aesthetic (Fraunces hed, Plex Mono kickers, hairline rules).
  - Fields per spec; default counts 10/5; persona dropdown reusing the existing `personasApi.list(false)` query.
  - Submit: `topicBatchesApi.create(payload)`; on success `router.push(`/topic-batches/${id}`)`.
  - Validation: theme + audience required; topic_count 1..30; keywords_per_topic 1..10.

## Task 7: Web — batch progress + HITL_T1 review

- [ ] Create `web/app/topic-batches/[id]/page.tsx`:
  - Suspense + React Query for initial fetch.
  - Open `topicBatchesApi.events(id)` SSE stream; update React Query cache on events.
  - Render `<BatchProgress/>` while status ∈ `{pending, generating, analysing}`.
  - Render `<CandidateGrid/>` (HITL_T1) while status ∈ `{ready_for_review, partially_promoted}`.
  - Render a read-only summary when `done` / `failed`.
- [ ] Create `web/components/topics/BatchProgress.tsx` — progress strip (3 phases) + live candidate rows as they land. Each row pulses while verdicts are loading, settles with the two-badge verdict.
- [ ] Create `web/components/topics/CandidateGrid.tsx`:
  - Sticky-header sheet, columns per spec.
  - Per-row checkbox `☑` defaults checked iff `existing === "no"`.
  - Inline-editable `Topic`, `Keywords` (debounced PATCH). PATCH body includes the operator identifier so the server can set `last_edited_by` / `last_edited_at`.
  - When a row's current `topic`/`keywords` differs from its `original_topic`/`original_keywords`, render an italic kicker beneath the row: `edited · original "{original_topic}"` — sourced directly from the snapshot fields, no diff computation needed.
  - Per-row `Voice` / `ADV` / `Widget` overrides (PATCH on change).
  - **Promote-as-refresh toggle.** For rows where `existing ∈ {"yes", "not_sure"}` AND `existing_url` is non-empty, render a small `Create new` ↔ `Refresh existing` segmented toggle next to the commission checkbox. Toggle state lives in component state (it's a per-promotion choice, not persisted on the candidate until promote-time). Default = `Create new`.
  - Rows with `last_error` non-null get a small error chip showing the truncated error; operator can still commission them but should know the verdict is unknown.
  - Bottom bar: `Commission {n} →` button; if some rows are in refresh mode, the count breaks down as `{n_create} new · {n_refresh} refresh`. "Skip all `existing=yes`" shortcut still present.
  - Submit: `topicBatchesApi.promote(id, {promotions: [{candidate_id, mode}]})`; on success show inline links to each new run with their mode badge.
- [ ] Create `web/components/topics/VerdictBadge.tsx` — the two-badge component. `Existing?` badge variants for `yes` (accent), `no` (ok), `not_sure` (warn). `Hot?` badge variants for `yes` (accent-deep), `no` (muted). Click to expand the note in a popover.
- [ ] In `web/app/runs/[runId]/page.tsx`, when `run.topic_candidate_id != null`, fetch the candidate + batch and show a breadcrumb like `From brief №42 · "保險新手指南"`.

## Task 8: Tests + verification

- [x] Backend tests pass (`pytest` — 218/218 green).
- [x] `ruff check .` clean on touched files (2 pre-existing errors in `agents/publish.py` from Task 4's commit, not new); `pyright` ratchet on `runs.py` 64 → 64 (no new errors).
- [x] Full happy path smoke against local dev:
  - Brief submitted (3×3), batch reached `ready_for_review` with 3 candidates carrying dedup + hot-topic verdicts.
  - HITL_T1: PATCH'd one candidate's topic + persona; `original_topic` preserved, `last_edited_by`/`last_edited_at` populated.
  - Promoted candidates as `create`; runs registered with `start_mode='create'` + `topic_candidate_id`; `promoted_run_id` written back.
  - **Bug found + fixed during smoke:** `content_tool/api/sse.py:_build_initial_state` did not propagate `start_mode`/`topic_candidate_id`/`target_audience` into the initial graph state, so the strategy router fell through to `fetch_article` and crashed on `None` `article_url`.
  - **Bug found + fixed during smoke:** `dry_publish` required `FetchedArticle` via `scalar_one()`; switched to `scalar_one_or_none()` and guarded `wp_post_id` so create-mode dry-publish returns `POST /wp/v2/posts` with `status=draft`.
  - Post-fix run drove cleanly through HITL_1 → writer/audit → HITL_2; WP published a draft and backfilled `runs.article_url`. The trailing compliance-log insert failed (pre-existing dev-env schema gap — `content_tool.compliance_log` relation absent from the active migrations chain; the integration test stubs it).
- [x] Front III smoke: direct `POST /runs` with `start_mode='create'` reached HITL_1 cleanly.
- [ ] **Follow-up — Task 5 gap:** `/costs/batch/{id}` endpoint is not implemented; only `/costs/run/{run_id}` exists. Track separately.

## Task 9: Docs + handoff

- [x] Update `CLAUDE.md` with a one-line addition under "Architecture" noting the two new entry modes (Front II batch + Front III single-create) and the `start_mode` switch.
- [x] Update the spec doc's "Open questions" section with actual decisions taken during implementation (e.g. final concurrency cap, retry behaviour, cost ceiling if added).
- [x] No README changes required.

---

## Risk notes

- **Cost.** A 30-topic batch with grounding + URL context on both dedup and hot-topic is 61 Gemini calls (1 + 30 + 30). The first batch is the cheapest signal we have to size the cost ceiling — don't add the ceiling preemptively.
- **Gemini rate limits.** `Semaphore(5)` is conservative. If we see 429s, lower to 3; if everything's fine after 5 batches, try 10.
- **WP draft publishing.** Make sure `WP_TARGET` is set correctly per environment before the first create-mode run hits publish. Refresh-mode behaviour is unchanged.
- **Backwards compat.** Refresh runs must keep passing all existing tests. Run the full `pytest` suite at the end of Tasks 1, 4, and 5 specifically to catch regressions early.
- **HITL_T1 race.** If the operator opens the review grid while the graph is still streaming, the commission checkbox should be disabled for any candidate whose verdicts are still `NULL`. Belt-and-braces: the `POST /promote` endpoint rejects promotion of any candidate with `existing IS NULL` or `hot_topic IS NULL`.
