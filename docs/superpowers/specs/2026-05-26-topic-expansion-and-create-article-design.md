# Topic Expansion & New-Article Creation

**Date:** 2026-05-26
**Status:** Approved design, pending implementation plan
**Owner:** Franco Ma

## Purpose

`/runs/new` today is Front I only — a ledger for refreshing existing Bowtie articles. The page already advertises two further fronts (Front II "Expand Topics" and Front III "Create New Articles") behind "In setting" placeholders ([web/app/runs/new/page.tsx:55](../../../web/app/runs/new/page.tsx)). This spec turns them on.

The reference implementation is the n8n workflow `AI Content Creation - 1) Create article`, which today runs entirely in Google Sheets + Drive + Docs. We bring it in-product so:

- A theme + audience brief produces a vetted **batch** of topic candidates without leaving the tool.
- Operators promote selected candidates to article runs in one click, instead of cutting-and-pasting between sheets.
- A single new article can be commissioned without going through the batch flow at all.
- Everything — costs, audit log, persona binding, HITL gates, WP publishing — runs through the same plumbing the refresh route already uses.

The page answers two new questions: *"what should we write about next?"* and *"please write that one."*

## Current state (for context)

- `/runs/new` shows three fronts; only Front I is active. The other two are buttons with "In setting" badges and `disabled` selection — see the `FRONTS` constant at [web/app/runs/new/page.tsx:55](../../../web/app/runs/new/page.tsx).
- Run pipeline: HITL_1 (after outline) and HITL_2 (after draft + audit). Root graph in [content_tool/graph/root.py](../../../content_tool/graph/root.py); strategy in [content_tool/graph/strategy.py](../../../content_tool/graph/strategy.py) (`fetch_article → gap_analysis → outline`); production in [content_tool/graph/production.py](../../../content_tool/graph/production.py) (`writer → resolve_citations → render_html → audit → bump?`).
- LLM client: [content_tool/gemini/](../../../content_tool/gemini/) (Gemini, JSON-mode + grounding + URL context already supported).
- WP client: [content_tool/wordpress/client.py:93](../../../content_tool/wordpress/client.py) — `upsert()` already POSTs when `post_id` is unset and PUTs when set, and passes through `status` (so `"draft"` works as-is).
- Personas: DB-backed (table seeded from YAML); `load_persona()` in [content_tool/policy/personas.py](../../../content_tool/policy/personas.py); writer + audit consume `{persona_block}`.
- Costs: [content_tool/observability/](../../../content_tool/observability/) tracks per-run cost; `/costs/run/{run_id}` + `/costs/summary` already exist.

## What we're borrowing from the n8n (and what we're discarding)

**Keeping (with adaptation):**

| n8n node | New home | Notes |
|---|---|---|
| `Settings` / `JSON Body` topic-gen prompt + schema (system prompt + `{topics: [{topic, keywords[]}]}` schema) | `prompts/topic_gen.md` + `content_tool/agents/topic_gen.py` | Same Hong-Kong繁中 system prompt, same JSON schema. Drop the n8n boilerplate `tools[]` wrapper — our Gemini client already handles that. |
| `Gemini API - Deduplication` (per-topic `existing` yes/no/not_sure + note + url) | `content_tool/agents/topic_dedup.py` | One Gemini call **per topic**, grounded with Google Search + URL context. Matches n8n behaviour. Run in parallel (asyncio gather with semaphore) — n8n's 25-item batching was a workaround for Sheets API limits we don't have. |
| `Gemini API - Hot Topic` (per-topic `hot_topic` yes/no + note) | `content_tool/agents/topic_hot.py` | Parallel with dedup. Same advisory-only role. |
| `Gemini API - Outline` (`{search_query, article_title, source_summary_markdown, outline_markdown, freshness_note}`) | Existing `content_tool/agents/outline.py` extended | Outline today consumes `gap_analysis` output. In `create` mode it skips `gap_analysis` and runs the n8n outline prompt instead. Same JSON schema. |
| `Gemini API - Writer` (Markdown w/ `%%meta desc%%`, `%%acf_adv%%`, `%%acf_widget%%`, `%%acf_faq%%`) | Existing `content_tool/agents/writer.py` | The Markdown dialect already matches the existing `render_html.py` shortcode parser. No renderer change needed. |
| Google Sheets `topic_batches`/`topic_candidates` rows | Postgres `topic_batches` + `topic_candidates` tables | Replaces Sheets entirely. |
| Google Drive folder + Google Docs outline | Run rows + existing run UI | The outline lives in `runs.outline_markdown` (or similar field on the run row), not a Drive doc. |
| n8n status-column polling | LangGraph + SSE | Same orchestration the refresh route uses. |

**Discarding:**

- Google Sheets / Drive / Docs as transport. All artifacts move to Postgres + the existing UI.
- The n8n `executeWorkflow` trigger that fans dedup/hot-topic out as a sub-workflow. Inside a single Python process we just `asyncio.gather` with a semaphore.
- The n8n "25-item batch + retry" — irrelevant outside Sheets API rate limits.
- Manual status-column flipping by the operator (`generate_topic`, `generate_outline`, `create_article`). Replaced by HITL_T1 (one new gate) plus the existing HITL_1/HITL_2.

## Aesthetic direction

The page identity is already set: a broadsheet **Assignment Ledger** with three fronts. Front II and Front III adopt the same vocabulary.

- **Front II — "Expand Topics."** A *commissioning brief* leads to a *story budget*. The form is a single-column brief sheet (theme, audience, must-cover, must-avoid), submitted to "open the budget." The batch progress page is a **budget meeting**: candidates land row by row as research returns, each row stamped with two badges (`已有 / 未有 / 未確定` for dedup, `熱 / 冷` for hot-topic). The HITL_T1 review is the Ledger grid the user already knows from Front I, but with extra columns and a "Commission" checkbox per row.
- **Front III — "Create New Articles."** Same Ledger grid as Front I, with `Article URL` removed and the existing Topic / Keywords / Mode / Voice / ADV / Widget columns retained. Mode is forced to `auto` (no `small_refresh`/`full_rewrite` since there's nothing to compare against). Each filed row becomes a `create`-mode run.

Motion is restrained to match Front I — no spinners, no toasts. The batch progress page uses the same SSE pulse as the run page.

**The unforgettable detail** is the **Two-Badge Verdict**: every candidate row in the HITL_T1 grid carries two small stamps in margin-thin caps, e.g. `已有 · LIHKG／Wikipedia` and `熱 · NEWS×3`. Visually distinctive, packs the dedup + hot-topic signal into a single eyeline scan.

## Page composition

### Front II form (`/runs/new` with `front=topics`)

Single-column brief. Fields mirror the n8n master sheet exactly so the team's mental model carries over:

- **Research theme** (required, free text)
- **Target audience** (required, free text)
- **# of topics** (number, default 10, max 30)
- **# of keywords per topic** (number, default 5, max 10)
- **Must cover** (textarea, optional)
- **Must avoid** (textarea, optional)
- **Priority focus** (textarea, optional)
- **Notes** (textarea, optional)
- **Voice** (persona dropdown, default `bowtie-editor`) — applied to every promoted candidate but editable per-row at HITL_T1.
- **ACF adv id** + **ACF widget id** (numeric, defaults 1/1) — same.

Submit creates a `topic_batch` row, kicks off `topic_expansion` graph, and redirects to `/topic-batches/{id}`.

### Batch progress (`/topic-batches/{id}`)

SSE-driven, same pattern as `/runs/{id}`. Shows:

- The brief at the top (collapsed accordion).
- A progress strip: `generating topics · 0/10` → `analysing candidates · 4/10` → `ready for review`.
- The candidate grid filling in as candidates land. Each row pulses while its dedup + hot-topic checks are in flight, then settles with the two-badge verdict.

When the batch reaches `ready_for_review`, the grid becomes interactive (HITL_T1).

### HITL_T1 review (same page, batch status = `ready_for_review`)

Sheet-like grid, sticky header. Columns:

| № | ☑ | Topic | Keywords | Existing? | Existing note | Hot? | Hot note | Voice | ADV | Widget |
|---|---|---|---|---|---|---|---|---|---|---|

- `№` — display order.
- `☑` — Commission checkbox. Defaults checked iff `existing == "no"`.
- `Topic`, `Keywords` — editable inline before promotion (operator may tighten language). When edited, an italic kicker `edited · original "…"` appears under the row showing the LLM's original suggestion (sourced from `original_topic` / `original_keywords`).
- `Existing?` / `Hot?` — coloured badges. Click the badge to expand the note (`existing_note` + `existing_url` for dedup; `hot_topic_note` for hot).
- `Voice`, `ADV`, `Widget` — pre-filled from batch defaults; per-row override.
- **Promote-as-refresh affordance.** Rows where `existing ∈ {"yes", "not_sure"}` and `existing_url` is non-empty get a small toggle next to the commission checkbox: `Create new` (default) ↔ `Refresh existing`. Picking `Refresh existing` promotes the row into the *refresh* pipeline against `existing_url` instead of spawning a new article. This is the operator's escape hatch for the "we already have something close — improve it instead" case.

Bottom bar: `Commission {n} →` button (count splits as `{n_create} new · {n_refresh} refresh` if both modes are in play) + "Skip all `existing=yes`" shortcut. Promotion fans out N runs of the appropriate mode; each one lands in `/runs/{run_id}` and follows the normal HITL_1 / HITL_2 path. The batch row updates with `promoted_run_ids` so the operator can return and see which runs came from this brief.

### Front III ledger (`/runs/new` with `front=create`)

Same component as Front I (`LedgerRowView`) with two changes:

1. The `Article URL` column is omitted.
2. The `Mode` cell is replaced by a static "Create" pill (no auto/refresh/full_rewrite options).

Submitting a row creates a `create`-mode run with `topic_candidate_id = NULL`. Otherwise identical to Front I.

## Data model

Two new tables. Both follow the project's snake_case / async-SQLAlchemy convention.

### `topic_batches`

```python
class TopicBatch(Base):
    __tablename__ = "topic_batches"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    research_theme: Mapped[str]
    target_audience: Mapped[str]
    topic_count: Mapped[int]
    keywords_per_topic: Mapped[int]
    must_cover: Mapped[str | None]
    must_avoid: Mapped[str | None]
    priority_focus: Mapped[str | None]
    notes: Mapped[str | None]
    persona_slug: Mapped[str]
    acf_adv_id: Mapped[int]
    acf_widget_id: Mapped[int]
    status: Mapped[str]  # see lifecycle below
    error: Mapped[str | None]
    created_by: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
    cost_cents: Mapped[int] = mapped_column(default=0)
```

Status lifecycle: `pending → generating → analysing → ready_for_review → partially_promoted → done | failed`.

- `pending` — row inserted, graph not started.
- `generating` — topic-gen Gemini call in flight.
- `analysing` — dedup + hot-topic running per candidate.
- `ready_for_review` — all candidates have both verdicts; HITL_T1 unlocked.
- `partially_promoted` — operator has promoted ≥1 candidate; remaining candidates still selectable.
- `done` — operator explicitly closes the batch (or all candidates promoted/skipped).
- `failed` — terminal error during gen or analyse.

### `topic_candidates`

```python
class TopicCandidate(Base):
    __tablename__ = "topic_candidates"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    batch_id: Mapped[UUID] = mapped_column(ForeignKey("topic_batches.id", ondelete="CASCADE"), index=True)
    position: Mapped[int]  # 1..N display order
    topic: Mapped[str]
    keywords: Mapped[list[str]] = mapped_column(JSONB)  # text[] also fine
    # Snapshot of the LLM's original suggestion (frozen at fan_out time, never overwritten).
    # Lets us answer "did the operator rewrite the LLM's topic?" without a separate audit table.
    original_topic: Mapped[str]
    original_keywords: Mapped[list[str]] = mapped_column(JSONB)
    existing: Mapped[str | None]  # "yes" | "no" | "not_sure" | None while in flight
    existing_note: Mapped[str | None]
    existing_url: Mapped[str | None]
    hot_topic: Mapped[str | None]  # "yes" | "no" | None
    hot_topic_note: Mapped[str | None]
    status: Mapped[str]  # "candidate" | "promoted" | "skipped" | "rejected"
    promote_mode: Mapped[str | None]  # "create" | "refresh" — set on promotion; null while candidate
    promoted_run_id: Mapped[UUID | None] = mapped_column(ForeignKey("runs.id"))
    operator_note: Mapped[str | None]
    last_edited_by: Mapped[str | None]  # email/identifier of the operator who last PATCHed this row
    last_edited_at: Mapped[datetime | None]
    last_error: Mapped[str | None]  # surfaced when dedup/hot-topic gave up after retries
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
```

### Changes to `runs`

Additive only — keep refresh-mode runs working without migration backfill:

- `start_mode: str` — `"refresh"` (default) or `"create"`.
- `topic_candidate_id: UUID | None` — FK to `topic_candidates.id`, nullable.
- `target_audience: str | None` — populated from the batch on create-mode runs; ignored elsewhere.
- `article_url` becomes nullable in DDL. In create mode it's `NULL` until publish; on draft publish we backfill it with the WP draft preview URL.

Existing rows: backfill `start_mode = 'refresh'`.

## Backend / API surface

### LangGraph — new `topic_expansion` subgraph

`content_tool/graph/topic_expansion.py`:

```
START → topic_gen → fan_out_candidates → [dedup, hot_topic] (parallel per candidate) → aggregate → END
```

- `topic_gen` (LLM): the n8n `Settings` topic-gen prompt, schema-constrained output, grounding + URL context on.
- `fan_out_candidates`: writes `topic_candidates` rows in `candidate` status with `existing=NULL`, `hot_topic=NULL`.
- `dedup` + `hot_topic`: per-candidate Gemini calls; fan out with `asyncio.Semaphore(max_concurrency=5)` to bound spend. Each writes the four/two fields back to its candidate row.
- `aggregate`: flips batch status to `ready_for_review`.

No interrupt inside the graph — the HITL_T1 gate is "graph completes → operator reviews → API call to promote." Same pattern as how the existing refresh evaluator hands off to a human (`/runs/new?evaluation_id=...`).

### LangGraph — `start_mode` on the existing production subgraph

[content_tool/graph/root.py](../../../content_tool/graph/root.py) currently runs `START → strategy → production → publish_or_revise`. We branch at `strategy`:

```python
def strategy_entry(state):
    if state.start_mode == "create":
        return "outline"  # skip fetch + gap_analysis
    return "fetch_article"
```

- `outline` agent gets a `start_mode`-aware system prompt: in create mode it runs the n8n outline prompt (SERP-research-driven, no existing article). In refresh mode it runs today's prompt (gap-analysis-driven). Single agent, two prompt branches — cleaner than two agents.
- `gap_analysis` is skipped in create mode (no diff exists). `state.gap_analysis_findings` stays empty; the audit agent already handles the empty-findings case (no-op).
- `audit` runs as today. In create mode it scores against the outline's `freshness_note` + coverage instead of a diff. The existing rubric (factual claims, prohibited terms, persona fit) still applies.
- `publish` (in `content_tool/agents/publish.py`): in create mode pass `post_id=None` and `status="draft"` to `WordPressClient.upsert()`. WP creates a new draft and returns a link; we store it in `runs.article_url`.

### FastAPI routes

New router `content_tool/api/routes/topic_batches.py`:

- `POST /topic-batches` — create batch + start `topic_expansion` graph. Returns `{id}`.
- `GET /topic-batches` — list (paginated, filter by status).
- `GET /topic-batches/{id}` — detail with candidates.
- `GET /topic-batches/{id}/events` — SSE stream of candidate updates (reuses `sse-starlette` patterns from runs).
- `PATCH /topic-batches/{id}/candidates/{candidate_id}` — operator edits topic/keywords/voice/ADV/widget before promotion.
- `POST /topic-batches/{id}/promote` — body `{promotions: [{candidate_id, mode: "create" | "refresh"}]}`. For each entry: in `create` mode, dispatch `POST /runs` with `start_mode="create"` and the candidate's topic/keywords/audience/persona; in `refresh` mode, require the candidate's `existing_url` to be non-empty and dispatch `POST /runs` with `start_mode="refresh"` and `article_url = existing_url`. Reject `refresh` promotions for candidates whose `existing_url` is blank. Update each candidate's `promoted_run_id`, `promote_mode`, and `status="promoted"`. Returns `[{candidate_id, run_id, mode}, …]`.
- `POST /topic-batches/{id}/candidates/{candidate_id}/skip` — operator skips without promoting.
- `POST /topic-batches/{id}/close` — operator declares the batch done.

Existing `POST /runs` (in [content_tool/api/routes/runs.py](../../../content_tool/api/routes/runs.py)) accepts a new optional body field `start_mode: "refresh" | "create"` and `topic_candidate_id: UUID | None`. `article_url` becomes optional iff `start_mode == "create"`.

### Costs & observability

- Per-batch cost = sum of (topic-gen call + dedup×N + hot-topic×N). Recorded on `topic_batches.cost_cents`.
- Per-run cost continues to use the existing path; promoted runs link back via `runs.topic_candidate_id → topic_candidates.batch_id`.
- `GET /costs/batch/{batch_id}` (analysis cost + sum of promoted-run costs) is a **follow-up, not shipped in v1** — see the implementation note under Decisions and plan Task 8. Only `GET /costs/run/{run_id}` exists today.
- Tracing: each Gemini call in `topic_expansion` opens an OTEL span with the batch id and (for dedup/hot-topic) the candidate id.

## Prompts (new)

Three new prompt templates under `prompts/`:

1. `prompts/topic_gen.md` — the n8n "資深香港 SEO 內容策略師" system prompt, verbatim. JSON schema: `{topics: [{topic, keywords[]}]}`.
2. `prompts/topic_dedup.md` — the n8n "香港網誌內容研究助理" system prompt, but rewritten to take **one** topic per call instead of a CSV. Schema: `{existing: "yes"|"no"|"not_sure", existing_note, existing_url}`. Trade-off: more Gemini calls vs n8n's batched-25 approach, but each call is grounded with focused search; easier to retry one bad candidate. Run with grounding + URL context on, `reasoning_effort: "low"`.
3. `prompts/topic_hot.md` — the n8n "香港繁中 SEO 研究助理" hot-topic system prompt, also rewritten per-topic. Schema: `{hot_topic: "yes"|"no", hot_topic_note}`. Same model + grounding.
4. The existing `prompts/outline.md` gets a `{create_mode_block}` substitution that swaps in the n8n outline prompt body when `start_mode == "create"`. Schema is identical to refresh-mode outline (already produces a Markdown outline string).

All four follow the existing `{placeholder}`-substitution convention so they live alongside the existing prompt files.

## Persona / voice integration

- `topic_gen` is **persona-aware** via the `target_audience` field, but the persona's banned-terms list is *not* enforced at the topic stage (we're brainstorming, not writing copy). The persona slug is recorded on the batch so promoted runs inherit it.
- `topic_dedup` and `topic_hot` are persona-blind. They're observational, not generative.
- `outline` and `writer` consume the persona block as today via `load_persona()`. In create mode the persona block is identical to refresh mode.
- `audit` enforces the persona's redline list against the draft — same as today.

## Non-goals

- **Topic clustering / SERP rank tracking.** Out of scope; this spec is about generating + filtering, not measuring.
- **Bulk auto-publish.** Create-mode runs always land in WP as **drafts** regardless of HITL_2 approval. An operator clicks publish in WP admin. This is the safety property we want for brand-new content.
- **Recurring batches / scheduled cron.** A batch is created manually. A future spec can layer scheduling on top.
- **Cross-batch deduplication.** A candidate dedup'd against the live blog doesn't check against in-flight batches. Add later if collisions become a problem.
- **Reading existing n8n master sheet for backfill.** We don't import historical batches.
- **Per-row editing of dedup verdict.** Operator can override at promotion (by checking a row marked `existing=yes`) but we don't let them flip the LLM verdict — the original verdict stays auditable on the row.
- **Multi-language.** Hong-Kong繁中 only, matching the n8n.

## Decisions (resolved 2026-05-26)

1. **Concurrency cap = `Semaphore(5)`, hard-coded.** Constructed in the `topic_expansion` graph factory, scoped to one batch run. Yields ~4-minute wall-clock for a 30-candidate batch (60 Gemini calls in waves of 5) against typical paid-tier Gemini quotas. Cost is independent of N — concurrency only changes wall-clock and 429-risk. Revisit only if we see rate-limit errors in production; bumping to 10 later is a one-line change.
2. **Retries = per-candidate ×2 with exponential backoff, then mark error.** If a dedup or hot-topic call fails after retries, the candidate is persisted with the failing verdict left `NULL` and `last_error` populated. The HITL_T1 grid renders these rows with a visible error chip so the operator can manually skip or commission them. The batch never fails because of a single bad candidate.
3. **No per-batch cost ceiling in v1.** We have no real cost number yet — the n8n didn't track it. After the first three batches we'll have concrete figures to decide a sensible cap; until then a guessed number would either block legit work or be meaninglessly high. Costs are still tracked on `topic_batches.cost_cents`. **Note (implementation):** the `GET /costs/batch/{id}` endpoint was *not* shipped in v1 — only `GET /costs/run/{run_id}` exists today. Batch cost aggregation is tracked as a separate follow-up (see plan Task 8).
4. **Promote-into-refresh shipped in v1.** The HITL_T1 grid exposes a `Create new` ↔ `Refresh existing` toggle on rows where `existing ∈ {"yes", "not_sure"}` and `existing_url` is non-empty. `POST /promote` accepts `{promotions: [{candidate_id, mode}]}`; in `refresh` mode it dispatches a normal refresh run against `existing_url` instead of a create-mode run. `topic_candidates.promote_mode` records the operator's choice.
5. **Edit history shipped in v1, minimal form.** `topic_candidates` carries `original_topic`, `original_keywords` (LLM snapshots, frozen at fan_out time), plus `last_edited_by` + `last_edited_at` (set on each PATCH). The HITL_T1 grid surfaces an `edited · original "…"` kicker beneath rows the operator has rewritten. Full per-field diff history is *not* tracked — the LLM original + the current value is what we need to answer "did the operator rewrite this?" Anything richer can land later without a migration if we add a `topic_candidate_edits` table.

## Items decided during implementation (resolved 2026-05-27)

These smaller knobs were left open pre-implementation; the choices made once the code was running:

- **Retry backoff curve = 3 attempts (2 retries), exponential `base * 2**attempt` with base `1.0s` plus jitter → delays ≈ 1s, 2s.** Implemented as `_retry_with_backoff` in `content_tool/graph/topic_expansion.py` (`_MAX_ATTEMPTS = 3`, `_BASE_BACKOFF_S = 1.0`), shared by `topic_gen`, dedup, and hot-topic calls. Lighter than the guessed "2s, 8s" — the dedup/hot agents have no internal retry of their own, so this is the single retry layer.
- **HITL_T1 grid is SSE-driven.** `web/app/topic-batches/[id]/page.tsx` opens the `/topic-batches/{id}/events` stream via `fetchEventSource` and invalidates the React Query cache on each event, with a `refetchInterval` fallback while the batch is still in flight — consistent with the run page.
- **`POST /promote` is synchronous and atomic.** All child run rows are created and validated inside one transaction (if any promotion can't be dispatched, the whole request is rejected), then the runners are started after commit. N is small (≤30) and error reporting is simpler this way.
