# Bowtie AI Content CMS — Stage 0: Refresh Route — Design Spec

**Date:** 2026-05-22
**Status:** Draft (awaiting review)
**Sub-project of:** "Full-fledged AI content creation, editing and approval CMS" — decomposed; this is **Stage 0** (the smallest CMS-shaped wedge), introducing the `Article` first-class entity and a `/library` surface alongside the existing Update route.
**Prior art:** [`2026-05-21-bowtie-ai-content-tool-update-route-mvp-design.md`](./2026-05-21-bowtie-ai-content-tool-update-route-mvp-design.md) — the MVP this spec extends.

---

## 0. Reading order

1. §1 — CMS structure (full target end-state, so you can see where this stage fits)
2. §2 — Refresh route goal & scope
3. §3 — Architecture & module map
4. §4 — Data model
5. §5 — Scanner algorithm
6. §6 — API surface
7. §7 — Web UI
8. §8 — Errors, observability, testing, configuration
9. §9 — Out of scope / fast-follow
10. §10 — Open questions

---

## 1. CMS structure (target end-state — context for staging)

### 1.1 Layered architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SURFACE LAYER (Next.js)                                                 │
│  Dashboard · Library · Calendar · Article Detail · Run Detail · Queue   │
│  HITL_1 · HITL_2 · Settings · Asset Library                              │
├─────────────────────────────────────────────────────────────────────────┤
│  EDITORIAL LAYER                                                         │
│  Approval workflow · Comments/threads · Assignments · Notifications     │
│  Queues per role · Audit trail · Per-article history                    │
├─────────────────────────────────────────────────────────────────────────┤
│  ENGINE LAYER (LangGraph)                                                │
│  Update graph (today) · Create graph · Refresh scanner                  │
│  Shared: writer · audit · resolve_citations · render_html · publish     │
├─────────────────────────────────────────────────────────────────────────┤
│  FOUNDATION LAYER                                                        │
│  Article (first-class) · Run · User · Role · WorkflowStatus              │
│  Compliance log · Cost tracking · Evals · Postgres + Alembic            │
├─────────────────────────────────────────────────────────────────────────┤
│  INTEGRATION LAYER                                                       │
│  WordPress REST · Gemini · (later) GA/GSC · Slack · Asset storage       │
└─────────────────────────────────────────────────────────────────────────┘
```

Today's MVP fills the Engine + Foundation + Integration layers for the Update route and a thin slice of the Surface layer (runs UI). The CMS is mostly about **growing the Editorial Layer**, **adding new Surface pages**, and **adding two more graphs in the Engine** (Create + Refresh).

### 1.2 Core entities (target)

```
              Article (first-class)
            ┌───────────────────────────────┐
            │ article_id (PK)               │
            │ wp_post_id (unique, nullable) │
            │ article_url                   │
            │ topic, persona, category      │
            │ workflow_status               │  ← later stages: backlog / drafting /
            │ owner_user_id (FK, later)     │    in_review / approved / published /
            │ next_scan_due_at              │    needs_refresh
            │ dismissed_until               │
            │ first_seen_at, updated_at     │
            └───────────────┬───────────────┘
                            │ 1
                            │ N
              ┌─────────────┴────────────────────────────────┐
              │ Run (existing)                                │
              │ + mode: update / create / refresh-action      │
              │ + triggered_by_evaluation_id (FK, new)        │
              │ + article_id (FK, new)                        │
              └─────────────┬─────────────────────────────────┘
                            │ 1
                            │ N
              ┌─────────────┴─────────────────────────────┐
              │ Drafts · Outlines · Citations · Renders   │
              │ Audit_runs · Compliance_log (existing)    │
              └───────────────────────────────────────────┘

              RefreshEvaluation (new — first piece of Editorial layer)
              ┌───────────────────────────────┐
              │ evaluation_id (PK)            │
              │ article_id (FK)               │
              │ evaluated_at                  │
              │ deterministic_findings (JSONB)│
              │ llm_findings (JSONB nullable) │
              │ staleness_score               │
              │ recommended_action            │
              │ outcome                       │
              │ resulting_run_id (FK nullable)│
              └───────────────────────────────┘

              Later stages add: User, Role, Comment, Thread, Assignment,
                                ReviewStage, Asset, TrafficSnapshot.
```

### 1.3 Surface map (target)

```
/                        Dashboard (grows from today's runs list)
/library                 Content library — table of every Article, filterable;
                         Refresh queue is one filter
/calendar                Editorial calendar (Kanban by workflow_status, or month view)
/articles/[id]           Per-article hub: current state, history, comments, actions
/queue                   Approval inbox (role-scoped)

/runs/new                Trigger form — gains a "mode" picker (update / create / refresh-action)
/runs/[id]               Run detail + SSE timeline (existing)
/runs/[id]/hitl1         Outline review (existing)
/runs/[id]/hitl2         Draft review (existing)

/settings/users          User & role management (Stage 2)
/assets                  Media library (Stage 5)
```

### 1.4 Sub-project staging

| Stage | Sub-project | Layer growth | New entities | New surfaces |
|---|---|---|---|---|
| **0 — this spec** | **Refresh route** | Foundation: introduces `Article`. Engine: scanner. Surface: thin `/library`. | `Article`, `RefreshEvaluation` | `/library` |
| 1 | Multi-mode authoring (Create) | Engine: Create graph. | (extends Article) | `/runs/new` mode picker; first slice of `/articles/[id]` |
| 2 | Identity & roles | Foundation: real auth, users, roles. | `User`, `Role` | `/settings/users`, login |
| 3 | Editorial workflow + Approval queue + Comments | Editorial layer (most of it). Generalises today's HITL_1/HITL_2 into configurable stages. | `ReviewStage`, `Assignment`, `Comment` | `/queue`, comments on HITL + `/articles/[id]` |
| 4 | Calendar / Dashboard | Surface layer. | (none new) | `/calendar`, richer `/` |
| 5 | Asset library | Integration + foundation. | `Asset` | `/assets` |
| 6 | GA/GSC + scheduled-publish + Slack | Integration layer. | `TrafficSnapshot` | refinements to `/library` ranking |
| 7+ | Multi-target publishing, full-text search, analytics | as needed | | |

Each stage gets its own spec → plan → implementation cycle.

---

## 2. Refresh route — goal & scope

### 2.1 Goal

A **queue-only monitor** that periodically evaluates Bowtie WordPress articles already known to this system and surfaces a prioritised "needs refresh" list to editors. The editor decides what to do — they click a queue row, which pre-fills the existing `/runs/new` Update form. Refresh itself **never** triggers a Run automatically.

### 2.2 In scope (Stage 0)

- Per-article scheduled scanning, default 30-day re-scan interval, daily cron tick that only re-scans due articles.
- Manual scan: whole-tick or per-article.
- Staleness signal: age + deterministic re-audit; LLM re-audit only invoked on candidates that fail deterministic, gated by a per-tick LLM cap.
- A thin `articles` table (first-class Article entity, minimum fields).
- An append-only `refresh_evaluations` table with a `superseded` lifecycle.
- A new `/library` Next.js page — table of all onboarded articles with default filter = "needs refresh", row actions (Trigger Update / Dismiss until), and "Run scan now".
- `/runs/new` extended to accept `article_id` and `evaluation_id` query params and show a read-only "Refresh context" card.
- Audit trace: `runs.article_id`, `runs.triggered_by_evaluation_id`, `refresh_evaluations.resulting_run_id`.
- Cost-meter integration; structlog + OTel spans matching existing patterns.

### 2.3 Out of scope (deferred — see §9)

- Auto-trigger Update from a Refresh evaluation ("action mode").
- GA / GSC traffic and ranking signals.
- WordPress crawl to discover articles not yet touched by the system.
- Slack digest of the queue.
- `/articles/[id]` detail page (lives in Stage 3).
- SSE progress for long-running scan ticks.
- User identity / role-attributed dismissals (Stage 2).
- Bulk operations.
- Re-evaluating the latest internal draft rather than published HTML.

---

## 3. Architecture & module map

```
                  ┌─────────────────────────────────┐
                  │ system cron (nightly, 03:00 HKT)│
                  └────────────┬────────────────────┘
                               │ invokes
                               ▼
               scripts/refresh_scan.py ──┐
                                          │ calls
                                          ▼
                  ┌────────────────────────────────────────┐
                  │ content_tool.refresh.scanner            │
                  │  1. select due articles                 │
                  │  2. skip in-progress / dismissed        │
                  │  3. fetch published HTML (WP client)    │
                  │  4. deterministic_audit                 │
                  │  5. if fail AND under LLM cap:          │
                  │       llm_audit (existing audit prompt) │
                  │  6. INSERT refresh_evaluations          │
                  │  7. UPDATE articles.next_scan_due_at    │
                  └─────┬───────────────────────────┬───────┘
                        │                            │ reads/writes
                        ▼                            ▼
              ┌─────────────────┐         ┌────────────────────┐
              │ FastAPI         │         │ Postgres            │
              │ /refresh/scan   │◄────────┤ articles            │
              │ /refresh/scan/X │         │ refresh_evaluations │
              │ /articles       │         │ runs (existing)     │
              │ /articles/X/    │         │ compliance_log      │
              │   dismiss       │         └────────────────────┘
              └────────┬────────┘
                       │ JSON
                       ▼
              ┌──────────────────────┐
              │ Next.js /library     │
              │   - table view       │
              │   - filters / sort   │
              │   - "Scan now"       │
              │   - "Trigger Update" │──► pre-fills /runs/new
              │   - "Dismiss until"  │
              └──────────────────────┘
```

### Module additions

- `content_tool/refresh/__init__.py`
- `content_tool/refresh/scanner.py` — orchestration (the 7 steps above)
- `content_tool/refresh/evaluator.py` — deterministic + LLM evaluation, returns a `RefreshEvaluation` Pydantic model
- `content_tool/refresh/deterministic_checks.py` — published-HTML-specific checks (broken links, dated phrasing, missing FAQ JSON-LD, drift)
- `content_tool/refresh/inventory.py` — article-table maintenance (backfill from runs, upsert, scheduling math)
- `content_tool/api/routes/refresh.py` — `/refresh/*` endpoints
- `content_tool/api/routes/articles.py` — `/articles/*` endpoints
- `scripts/refresh_scan.py` — CLI entrypoint invoked by cron
- `web/app/library/page.tsx`
- `web/components/LibraryTable.tsx`
- `web/components/StalenessIndicator.tsx`
- `web/components/RefreshFindingsPanel.tsx`
- `web/components/DismissDialog.tsx`
- `web/components/ArticleDetailDrawer.tsx`
- shadcn additions: `calendar`, `sheet` (verify `table` already present)
- Tests under `tests/unit/refresh/`, `tests/integration/test_refresh_scan_e2e.py`, `web/tests/library.spec.ts`, `web/tests/refresh-context.spec.ts`

### No changes to

The existing LangGraph root graph, the Update route, HITL_1, HITL_2, `publish_to_wordpress`, the `compliance_log` table.

---

## 4. Data model

### 4.1 `content_tool.articles` (new)

```sql
CREATE TABLE content_tool.articles (
  article_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_url         TEXT NOT NULL,
  wp_post_id          INT,                          -- nullable until first successful fetch_article binds it
  topic               TEXT,                         -- copied from most recent Run
  persona             TEXT,
  topic_category      TEXT,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_persisted_at   TIMESTAMPTZ,                  -- max(compliance_log.persisted_at) for this article
  next_scan_due_at    TIMESTAMPTZ NOT NULL,         -- scheduler key
  dismissed_until     TIMESTAMPTZ,
  dismissed_by        TEXT,                         -- free-text in v1; becomes FK in Stage 2
  dismissed_reason    TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX articles_article_url_uidx ON content_tool.articles (article_url);
CREATE INDEX articles_next_scan_due_idx ON content_tool.articles (next_scan_due_at)
  WHERE dismissed_until IS NULL OR dismissed_until < now();
CREATE INDEX articles_wp_post_id_idx ON content_tool.articles (wp_post_id) WHERE wp_post_id IS NOT NULL;
```

Notes:
- `article_url` is the natural key. Same URL = same Article.
- `wp_post_id` is learned lazily — first successful `fetch_article` per article_url backfills it.
- `next_scan_due_at` is the scheduler's primary index.

### 4.2 `content_tool.refresh_evaluations` (new — append-only)

```sql
CREATE TABLE content_tool.refresh_evaluations (
  evaluation_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id              UUID NOT NULL REFERENCES content_tool.articles(article_id) ON DELETE CASCADE,
  evaluated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanner_version         TEXT NOT NULL,
  trigger_source          TEXT NOT NULL,             -- "cron" | "manual_api" | "manual_per_article"
  age_days                INT NOT NULL,
  fetched_html_hash       TEXT,                      -- sha256 of current published HTML
  deterministic_findings  JSONB NOT NULL,
  llm_findings            JSONB,
  llm_skipped_reason      TEXT,                      -- "deterministic_passed" | "cap_exceeded" | "in_progress_run" | "scanner_error" | "llm_error" | null
  staleness_score         NUMERIC(4,2) NOT NULL,     -- 0.00–10.00
  recommended_action      TEXT NOT NULL,             -- "refresh" | "monitor" | "ok"
  outcome                 TEXT NOT NULL DEFAULT 'open',  -- "open" | "triggered" | "dismissed" | "superseded"
  resulting_run_id        UUID REFERENCES content_tool.runs(run_id),
  outcome_set_at          TIMESTAMPTZ,
  outcome_set_by          TEXT,
  tokens_in               INT,
  tokens_out              INT,
  est_cost_usd_cents      INT,
  latency_ms              INT
);
CREATE INDEX refresh_evals_article_evaluated_idx
  ON content_tool.refresh_evaluations (article_id, evaluated_at DESC);
CREATE INDEX refresh_evals_open_idx
  ON content_tool.refresh_evaluations (recommended_action, outcome)
  WHERE outcome = 'open' AND recommended_action = 'refresh';
```

**Outcome lifecycle:**
- `open` — fresh evaluation; awaits editor action or the next scan.
- `triggered` — editor pre-filled `/runs/new` and submitted; `resulting_run_id` set.
- `dismissed` — editor clicked Dismiss; `articles.dismissed_until` set on parent.
- `superseded` — a later scan produced a newer evaluation; old row auto-flipped from `open` → `superseded` when the new one is INSERTed (atomic in scanner).

### 4.3 Changes to `content_tool.runs`

```sql
ALTER TABLE content_tool.runs
  ADD COLUMN article_id UUID REFERENCES content_tool.articles(article_id),
  ADD COLUMN triggered_by_evaluation_id UUID REFERENCES content_tool.refresh_evaluations(evaluation_id);
CREATE INDEX runs_article_id_idx ON content_tool.runs (article_id);
```

- `article_id` — set at trigger time by upserting an `articles` row by `article_url`. Lets us go Article → all Runs.
- `triggered_by_evaluation_id` — non-null only when the Run was initiated from a Refresh queue row.

### 4.4 Alembic migration (single revision)

`2026_05_22_add_refresh_route.py`:

1. Create `articles`, `refresh_evaluations`, indexes.
2. Add columns to `runs`, create index.
3. Inline backfill:

```sql
INSERT INTO content_tool.articles (article_url, wp_post_id, topic, persona, topic_category,
                                    first_seen_at, last_persisted_at, next_scan_due_at)
SELECT DISTINCT ON (r.article_url)
       r.article_url,
       fa.wp_post_id,
       r.topic, r.persona, r.topic_category,
       MIN(r.created_at) OVER (PARTITION BY r.article_url) AS first_seen_at,
       MAX(cl.persisted_at) OVER (PARTITION BY r.article_url) AS last_persisted_at,
       COALESCE(MAX(cl.persisted_at) OVER (PARTITION BY r.article_url), now()) + INTERVAL '30 days'
FROM content_tool.runs r
LEFT JOIN content_tool.fetched_articles fa ON fa.run_id = r.run_id
LEFT JOIN content_tool.compliance_log cl ON cl.run_id = r.run_id
ON CONFLICT (article_url) DO NOTHING;

UPDATE content_tool.runs r
SET article_id = a.article_id
FROM content_tool.articles a
WHERE a.article_url = r.article_url;
```

If pre-migration `runs` row count exceeds ~5k, lift backfill to a one-shot script (see §10 open question 2).

### 4.5 SQLAlchemy + Pydantic surface

New `Article` and `RefreshEvaluation` mapped classes in `content_tool/db/models.py` mirroring the DDL. The existing `Run` class gets `article_id` and `triggered_by_evaluation_id`, plus a `relationship("Article", back_populates="runs")`.

Pydantic (in `content_tool/api/schemas.py`):

```python
class ArticleOut(BaseModel):
    article_id: UUID
    article_url: str
    wp_post_id: int | None
    topic: str | None
    persona: str | None
    topic_category: str | None
    first_seen_at: datetime
    last_persisted_at: datetime | None
    next_scan_due_at: datetime
    dismissed_until: datetime | None
    latest_evaluation: "RefreshEvaluationOut | None"
    open_runs_count: int

class RefreshEvaluationOut(BaseModel):
    evaluation_id: UUID
    evaluated_at: datetime
    age_days: int
    staleness_score: Decimal
    recommended_action: Literal["refresh", "monitor", "ok"]
    deterministic_findings: dict
    llm_findings: dict | None
    llm_skipped_reason: str | None
    outcome: Literal["open", "triggered", "dismissed", "superseded"]
    resulting_run_id: UUID | None
```

---

## 5. Scanner algorithm

### 5.1 Scheduling math

| Event | `next_scan_due_at` becomes |
|---|---|
| Article inserted (backfill or new Run creates it) | `COALESCE(last_persisted_at, now()) + REFRESH_DEFAULT_INTERVAL_DAYS` (default 30) |
| Scan result `recommended_action = "ok"` | `now() + REFRESH_OK_INTERVAL_DAYS` (default 30) |
| Scan result `recommended_action = "monitor"` | `now() + REFRESH_MONITOR_INTERVAL_DAYS` (default 14) |
| Scan result `recommended_action = "refresh"` | unchanged (stays overdue → shows in queue) |
| Editor sets `dismissed_until` | `dismissed_until` (so the article becomes due the moment dismissal expires; consistent with §10.5) |
| Run for this article reaches `persisted` | `compliance_log.persisted_at + REFRESH_DEFAULT_INTERVAL_DAYS` |

### 5.2 Selection query

```sql
SELECT article_id, article_url, wp_post_id, last_persisted_at, first_seen_at
FROM content_tool.articles a
WHERE a.next_scan_due_at <= now()
  AND (a.dismissed_until IS NULL OR a.dismissed_until < now())
  AND NOT EXISTS (
    SELECT 1 FROM content_tool.runs r
    WHERE r.article_id = a.article_id
      AND r.status IN ('pending','strategy','hitl_1','production','hitl_2','persisted')
  )
ORDER BY a.next_scan_due_at ASC
LIMIT :batch_size;
```

### 5.3 Per-article scan flow

Pseudocode (`content_tool/refresh/scanner.py::scan_article`):

```python
for article in due_articles:
    try:
        wp_post = await wp_client.fetch_post_by_url(article.article_url)
        if wp_post is None:
            insert_evaluation(article, recommended_action="ok",
                              deterministic_findings={"note": "wp_post_not_found"},
                              llm_skipped_reason="no_published_html")
            advance_schedule(article, action="ok")
            continue

        html_hash = sha256(wp_post.content_html)
        if article.wp_post_id is None:
            article.wp_post_id = wp_post.id

        det_result = deterministic_audit_published_html(
            html=wp_post.content_html,
            modified_gmt=wp_post.modified_gmt,
            last_persisted_at=article.last_persisted_at,
        )

        llm_result, llm_skipped_reason = None, None
        if det_result.passed:
            llm_skipped_reason = "deterministic_passed"
        elif llm_calls_this_tick >= REFRESH_LLM_CAP_PER_TICK:
            llm_skipped_reason = "cap_exceeded"
        else:
            llm_result = await llm_audit_published(wp_post.content_html, persona=article.persona)
            llm_calls_this_tick += 1

        score, action = compute_staleness(det_result, llm_result, age_days)

        with tx:
            db.execute(
                "UPDATE refresh_evaluations SET outcome='superseded' "
                "WHERE article_id = :id AND outcome='open'",
                {"id": article.article_id},
            )
            insert_evaluation(article, score, action, det_result, llm_result, llm_skipped_reason)
            db.execute(
                "UPDATE articles SET next_scan_due_at = :due, updated_at=now() WHERE article_id = :id",
                {"due": advance(action), "id": article.article_id},
            )
    except Exception as e:
        log.error("refresh_scan_failed", article_id=str(article.article_id), exc_info=True)
        insert_evaluation(article, recommended_action="ok",
                          deterministic_findings={"error": str(e)[:500]},
                          llm_skipped_reason="scanner_error")
        db.execute(
            "UPDATE articles SET next_scan_due_at = now() + INTERVAL '1 day' WHERE article_id = :id",
            {"id": article.article_id},
        )
```

### 5.4 Deterministic checks

Reuses `content_tool/agents/audit_checks.py` patterns. New checks in `content_tool/refresh/deterministic_checks.py`:

| Check | Severity | Implementation |
|---|---|---|
| Broken outbound links | medium per link | async HEAD with 3s timeout; ignores `link_check_ignore_domains`; 4xx/5xx/timeout = broken |
| Dated phrasing | low per match | regex over body: `\b(20\d{2})\b` where year < now().year − `dated_phrasing_year_lookback` (default 1); `\b(as of \w+ 20\d{2})\b` |
| Missing FAQ JSON-LD on FAQ articles | high | HTML contains FAQ shortcode/widget but no `<script type="application/ld+json">…FAQPage…` |
| Stale modified_gmt vs body content year | low | body mentions year Y > `modified_gmt.year` |
| HTML drift from render_html golden patterns | medium | expected `<h2>` / `<h3>` nesting, mandatory disclaimers present, shortcode positions consistent |
| Existing `audit_checks.py` deterministic rules | as-coded | re-run against published HTML |

`det_result.passed = severity_high == 0 AND severity_medium <= audit_det_medium_threshold` (default 1).

### 5.5 LLM gate

LLM `audit` invoked only when all three:
1. `not det_result.passed`
2. `llm_calls_this_tick < REFRESH_LLM_CAP_PER_TICK` (default 20)
3. No in-progress Run for this article (already filtered in selection)

The prompt is the existing `audit` prompt, given the **currently-published HTML** as if it were a draft. Output stored in `refresh_evaluations.llm_findings` with the same shape as `audit_runs.llm_findings`.

### 5.6 Composite staleness score

```
age_factor = min(10, 10 * age_days / age_full_score_days)   # saturates at 180d
llm_factor = (10 if llm_findings.severity_high > 0
              else 5 if llm_findings and llm_findings.severity_medium > 0
              else 0)

score = clip(0, 10,
    age_weight        * age_factor
  + det_high_weight   * det_high * 10
  + det_medium_weight * det_medium * 5
  + llm_weight        * llm_factor
)

recommended_action =
    "refresh"  if score >= refresh_threshold (6.0)
                 OR det_high > 0
                 OR (llm_findings and llm_findings.severity_high > 0)
    "monitor"  if score >= monitor_threshold (3.0)
    "ok"       otherwise
```

Weights and thresholds live in `config/refresh.yaml`.

### 5.7 Concurrency, idempotency, tick lock

- **Concurrency:** `asyncio.gather` over per-article tasks with `Semaphore(REFRESH_CONCURRENCY)` (default 4).
- **Idempotency:** each per-article scan is its own transaction; partial-tick crashes leave unscanned articles untouched, already-scanned articles have new evaluations in place. The supersede-then-insert pattern is atomic per article.
- **Tick lock:** `pg_advisory_lock(REFRESH_TICK_LOCK_KEY)` wraps the whole tick. Prevents overlap between cron and a concurrent `POST /refresh/scan`. Released at tick end.

### 5.8 Manual scan paths

- `POST /refresh/scan` — runs immediately, returns when the tick completes (capped by `batch_size`).
- `POST /refresh/scan/{article_id}` — single-article forced scan; bypasses `next_scan_due_at` but still honors `dismissed_until` (caller can override with `force=true`) and in-progress-Run guard (409 if blocked).

---

## 6. API surface

### 6.1 `routes/articles.py`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/articles` | List with filters: `needs_refresh`, `persona`, `topic_category`, `q`, `sort` (`staleness` \| `next_scan_due` \| `last_persisted`), `limit`, `offset`. Returns `{ items: ArticleOut[], total: int }` with joined `latest_evaluation` and `open_runs_count`. |
| `GET` | `/articles/{article_id}` | Article detail with last 10 evaluations and last 10 Runs. |
| `POST` | `/articles/{article_id}/dismiss` | Body: `{ until: ISO8601, reason?: string, dismissed_by: string }`. Sets `dismissed_until`; flips latest open evaluation to `outcome='dismissed'`. |
| `DELETE` | `/articles/{article_id}/dismiss` | Clears `dismissed_until`. |

### 6.2 `routes/refresh.py`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/refresh/scan` | Body (optional): `{ article_ids?: UUID[], force?: bool }`. Synchronous. Returns `{ tick_id, scanned, evaluations_created, llm_calls, est_cost_usd_cents, started_at, finished_at, skipped: [{article_id, reason}] }`. |
| `POST` | `/refresh/scan/{article_id}` | Single-article forced scan. Returns the new `RefreshEvaluationOut`. 409 on in-progress Run; 410 on dismissed (override via `?force=true`). |
| `GET` | `/refresh/evaluations/{evaluation_id}` | Single evaluation (for the `/runs/new` Refresh context card). |

### 6.3 Changes to `routes/runs.py`

- `POST /runs` accepts optional `triggered_by_evaluation_id`. Behaviour:
  - Upsert `articles` by `article_url`; set `runs.article_id`.
  - If `triggered_by_evaluation_id` provided: validate it belongs to this article and `outcome='open'`. Set `runs.triggered_by_evaluation_id`. After Run insert, flip evaluation to `outcome='triggered'`, set `resulting_run_id`.
- `GET /runs/{run_id}` response gains `article_id` and `triggered_by_evaluation` (joined `RefreshEvaluationOut | null`).

### 6.4 Error responses

- `POST /refresh/scan/{article_id}` → `409 { detail: "in_progress_run", run_id }` when an active Run exists.
- `POST /articles/{id}/dismiss` → `422` when `until` is in the past.
- `POST /refresh/scan` with unknown `article_ids` → `404` with offending IDs.
- `POST /refresh/scan` while another tick holds the advisory lock → `409 { detail: "scan_in_progress" }`.

### 6.5 SSE

No new SSE events. Scanner is a synchronous batch job; existing `/runs/{id}/events` remains the SSE surface. Long-running-tick SSE is captured in §9 as fast-follow.

---

## 7. Web UI

### 7.1 `/library` page

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Library                                                  [Run scan now]  │
│                                                                            │
│  Filter: [Needs refresh ▼] [Persona ▼] [Category ▼] [Search...]            │
│  Sort:   [Staleness ▼]                                                     │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │  Topic / URL              Persona   Last      Staleness  Action     │   │
│  │                                     persisted                       │   │
│  ├────────────────────────────────────────────────────────────────────┤   │
│  │ ● VHIS premium guide…    family    142d ago    8.4 ●●●● [Trigger]  │   │
│  │   /vhis/premium-guide                                    [Dismiss▾] │   │
│  ├────────────────────────────────────────────────────────────────────┤   │
│  │ ● Critical illness…      young pro 91d ago     5.1 ●●○○ [Trigger]  │   │
│  │   /critical-illness/…                                    [Dismiss▾] │   │
│  ├────────────────────────────────────────────────────────────────────┤   │
│  │ ○ Voluntary contribution… retiree  21d ago     1.2 ●○○○ [Trigger]  │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  Showing 1–25 of 87 · [< 1 2 3 4 >]                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

Row click → right-side drawer with latest evaluation findings (deterministic + LLM), last 3 Runs, and the same Trigger/Dismiss controls.

### 7.2 Columns

| Column | Source |
|---|---|
| Status dot (filled = needs refresh, half = monitor, hollow = ok) | `latest_evaluation.recommended_action` |
| Topic | `articles.topic` |
| URL (truncated; link out to bowtie.com.hk) | `articles.article_url` |
| Persona | `articles.persona` |
| Last persisted | `articles.last_persisted_at` (relative, e.g. "142d ago") |
| Staleness | `latest_evaluation.staleness_score` + dot-rating |
| Top reason (truncated ~40 chars) | first finding message from `deterministic_findings` or `llm_findings` |
| Action buttons | "Trigger" → `/runs/new?article_id=X&evaluation_id=Y`; "Dismiss" → 7d / 30d / 90d / Custom |
| Next scan due | `articles.next_scan_due_at` (visible only when filter = "All") |

Default filter: `needs_refresh=true`. One click to toggle "All articles".

### 7.3 Top-level "Run scan now"

`POST /refresh/scan`. Button shows loading; on response, `toast.success("Scanned 47 articles, 3 new candidates")`. Disabled while another scan runs (server returns 409).

### 7.4 Per-row "Dismiss until" dropdown

shadcn `DropdownMenu` items:
- 7 days · 30 days · 90 days → `POST /articles/{id}/dismiss { until: now+Nd }`
- Custom… → opens `DismissDialog` (shadcn Calendar + reason)
- Clear dismissal (only if currently dismissed) → `DELETE /articles/{id}/dismiss`

### 7.5 Changes to `/runs/new`

`web/app/runs/new/page.tsx`:
- Reads `article_id` and `evaluation_id` from `useSearchParams`.
- If `article_id` present: pre-fills `article_url`, `persona`, `topic`, `topic_category`, suggests `mode` (high severity → `full_rewrite`, else `small_refresh`).
- If `evaluation_id` present: fetches via `GET /refresh/evaluations/{id}`, renders a read-only "Refresh context" card above the form.
- On submit, includes `triggered_by_evaluation_id` in the body.

### 7.6 New components

| Component | Purpose | Reuses |
|---|---|---|
| `LibraryTable.tsx` | Main table, row-click, per-row actions | shadcn Table |
| `StalenessIndicator.tsx` | Dot-rating + numeric score | Tailwind, `cn` |
| `RefreshFindingsPanel.tsx` | Read-only findings display; used in drawer **and** on `/runs/new` | patterns from `GapAnalysisView` |
| `DismissDialog.tsx` | Date picker + reason | shadcn Dialog + Calendar |
| `ArticleDetailDrawer.tsx` | Right-side sheet with evaluation + run history | shadcn Sheet |

shadcn additions needed: `calendar`, `sheet`.

### 7.7 Navigation

`app/layout.tsx` grows to a thin top bar: `Bowtie Content Tool · Runs · Library · Cost`.

### 7.8 State + data fetching

- React Query keys: `["articles", filters]`, `["article", id]`, `["evaluation", id]`, `["refresh-tick", tickId]`.
- `refetchInterval: 3000` on the article list when default filter = needs_refresh (mirrors today's runs list pattern).
- Mutations with `useMutation` + `queryClient.invalidateQueries`. `sonner` toasts.

### 7.9 Web tests (Playwright)

- `web/tests/library.spec.ts` — page loads, default filter is "needs refresh", "Trigger" navigates to `/runs/new` with query params, dismiss dropdown opens.
- `web/tests/refresh-context.spec.ts` — `/runs/new?article_id=X&evaluation_id=Y` (mocked API) shows the Refresh context card.

---

## 8. Errors, observability, testing, configuration

### 8.1 Error handling

| Failure mode | Behaviour |
|---|---|
| WP fetch fails (timeout / 5xx / network) | Caught; structured log; evaluation row with `deterministic_findings={"error": "wp_fetch_failed", …}`, `recommended_action="ok"`, `llm_skipped_reason="scanner_error"`. `next_scan_due_at += REFRESH_RETRY_INTERVAL_DAYS` (default 1). |
| WP returns 404 | Same shape with `note="wp_post_not_found"`. Normal ok-cadence. Editor can permanently dismiss. |
| LLM transient error | Retry-once with backoff inside `RealGeminiClient`. On final failure: evaluation with `llm_findings=null`, `llm_skipped_reason="llm_error"`; action derived from deterministic only. |
| Deterministic check raises | Per-check try/except; failed check lands as a `severity="low"` finding with `message="check_X_errored"`. Scan continues. |
| Tick-lock contention | `POST /refresh/scan` → `409 { detail: "scan_in_progress" }`. Cron entrypoint logs and exits 0. |
| In-progress Run | Skipped in selection. `POST /refresh/scan/{id}` → `409`. |
| Tick dies mid-run | Unscanned articles keep old `next_scan_due_at`; re-running is idempotent. |
| Backfill migration fails | Alembic transaction rollback. No app code reads new tables until migration applied. |

### 8.2 Observability

- **Structlog** (matches existing pattern from `0637ed7 feat(ops): structlog + OTel tracing`):
  - `refresh_scan_tick.started`, `refresh_scan_tick.finished` (tick_id, scanned, evaluations_created, llm_calls, est_cost_usd_cents, duration_ms)
  - `refresh_scan_article.started`, `refresh_scan_article.finished` (tick_id, article_id, article_url, det_passed, llm_called, recommended_action, staleness_score)
  - `refresh_scan_article.failed` (tick_id, article_id, error)
- **OTel spans**:
  - Root `refresh.tick`.
  - Child `refresh.article` per article (attrs: `article_id`, `det.severity_high`, `llm.called`, `staleness_score`).
  - Existing Gemini span propagates as child of `refresh.article`.
- **Cost meter**: each evaluation contributes `tokens_in/out` + `est_cost_usd_cents` with `kind="refresh_scan"`. The existing UI cost meter (`1defcf9 feat(ops): cost endpoints + UI meter`) gains a "Refresh scans (last 30d)" tile.
- **Compliance log**: Refresh evaluations are **not** written to `compliance_log` — that stays one-row-per-persisted-publish. Refresh has its own audit trail in `refresh_evaluations` (immutable except for the `outcome` field, which is append-once via supersede-then-insert).

### 8.3 Testing

| Layer | Coverage |
|---|---|
| Unit | Each deterministic check with golden HTML fixtures. `compute_staleness` table-driven cases. `advance_schedule` math. |
| Module | `scanner.scan_article(...)` with respx-mocked WP fetch + fake Gemini; assert evaluation row written; LLM-cap and dismiss / in-progress-Run skips. |
| Module | `scanner.scan_tick(...)` over a 5-article fixture: 2 ok, 2 needs-refresh (det-fail), 1 dismissed. Assert advisory-lock, supersede-then-insert atomicity. |
| Integration | E2E: seed 3 articles + 1 in-progress Run; `POST /refresh/scan`; assert response shape, DB state, skip behaviour. |
| Integration | Click-through: create evaluation → `POST /runs` with `triggered_by_evaluation_id` → assert evaluation `outcome='triggered'`, `resulting_run_id` set. |
| Web (Playwright) | `library.spec.ts`, `refresh-context.spec.ts` (per §7.9). |
| Backfill | Alembic test: seed pre-Refresh-era runs+compliance rows, run upgrade, assert `articles` populated and `runs.article_id` linked. |

### 8.4 Configuration

New `config/refresh.yaml`:

```yaml
scheduling:
  default_interval_days: 30
  ok_interval_days: 30
  monitor_interval_days: 14
  retry_interval_days: 1

scan:
  batch_size: 200
  concurrency: 4
  tick_lock_key: 7421901   # fixed integer for pg_advisory_lock
  llm_cap_per_tick: 20

scoring:
  age_full_score_days: 180
  det_high_weight: 0.2
  det_medium_weight: 0.1
  llm_weight: 0.3
  age_weight: 0.4
  refresh_threshold: 6.0
  monitor_threshold: 3.0

deterministic:
  link_check_timeout_ms: 3000
  link_check_concurrency: 8
  link_check_ignore_domains:
    - facebook.com
    - twitter.com
    - x.com
    - linkedin.com
  dated_phrasing_year_lookback: 1
  audit_det_medium_threshold: 1
```

New env vars (validated by existing `pydantic-settings` in `content_tool/config.py`):
- `REFRESH_CONFIG_PATH=config/refresh.yaml`
- `REFRESH_CRON_ENABLED=true`

No new secrets. Refresh reuses existing `WP_*` and `GEMINI_*` credentials.

### 8.5 Cron config (deployment artefact)

`deploy/cron/refresh.cron` template — suggesting `0 3 * * *` HKT:

```
0 3 * * *  REFRESH_CRON_ENABLED=true /opt/bowtie-content-tool/scripts/refresh_scan.py >> /var/log/bowtie/refresh.log 2>&1
```

Operationalisation (system cron vs k8s `CronJob` vs GH Actions) is an ops decision; matches the existing nightly-reference-eval pattern in this repo. Noted as open question §10.1.

---

## 9. Out of scope (fast-follow & later stages)

| # | Item | Why deferred | Lives in |
|---|---|---|---|
| 1 | Auto-trigger Update from Refresh (action mode) | Queue-only chosen for v1; auto-trigger needs confidence gating and HITL_2 queue capacity controls. | Stage 1+ |
| 2 | GA / GSC traffic + ranking signals | Pulls Google API credentials, OAuth, URL→property mapping, daily pulls, `TrafficSnapshot` table. | Stage 6 |
| 3 | WordPress crawl for never-touched articles | Today's inventory is onboard-by-touch. Crawl needs pagination, deletes, slug-change handling. | Stage 5/6 |
| 4 | Slack digest of the queue | Notification layer; cheap fast-follow once the queue is validated. Use `bowtie-ins` connector. | Fast-follow |
| 5 | `/articles/[id]` detail page | Per-article hub is part of the Editorial workflow stage. | Stage 3 |
| 6 | SSE for long-running scan ticks | `POST /refresh/scan` is sync in v1. Add `/refresh/ticks/{id}/events` + progress bar if ticks exceed ~2 min. | Fast-follow |
| 7 | Editor-driven per-article re-evaluation cadence | Today, math is uniform. Per-article custom cadence ("scan this regulatory article every 7 days") needs a UI control. | Fast-follow |
| 8 | User identity & dismissal attribution | `dismissed_by` is free-text in v1. Real user identity is Stage 2. | Stage 2 |
| 9 | Bulk operations | Useful at scale; deferred until queue volume justifies. | Fast-follow |
| 10 | Audit re-run on latest internal draft instead of published HTML | v1 always evaluates published HTML (truth on the website). | Fast-follow |

---

## 10. Open questions

Each has a default in the spec; we resolve if/when they bite.

1. **Cron host.** System cron on the FastAPI host, k8s `CronJob`, or GitHub Actions. Match existing nightly-reference-eval cron pattern. **Default:** document a `deploy/cron/refresh.cron` placeholder; ops chooses the host.
2. **Initial backfill cardinality.** If pre-migration `runs` row count >5k, lift the inline backfill to a one-shot script. **Default:** inline backfill with a guard comment.
3. **Cost ceiling for LLM scans.** Cap × daily ≈ 600 LLM scans/month ≈ HK$60–240 at Gemini Flash. **Default:** ship `llm_cap_per_tick=20`; revisit after 1 month of real data.
4. **Deterministic→LLM threshold.** `severity_high > 0 OR severity_medium > 1` is the current trip-wire. May need tuning against the real corpus. **Default:** ship the configured threshold; expect tuning within 2 weeks.
5. **Dismissal expiry behaviour.** When `dismissed_until` passes, re-evaluate immediately or wait until `next_scan_due_at`? **Default:** re-evaluate immediately — implemented by setting `next_scan_due_at = dismissed_until` when the editor dismisses (see §5.1), so the article becomes due the instant dismissal expires. Selection query stays simple (`next_scan_due_at <= now() AND (dismissed_until IS NULL OR dismissed_until < now())`).
6. **Scoring weights review.** Linear formula is simple by design; non-linear (age plateau then accelerate) may calibrate better. **Default:** ship linear; instrument `staleness_score` histogram in logs for review.

---

## Implementation order (preview — not the implementation plan)

This is just to show the spec is shippable in small increments. The actual plan comes from invoking `writing-plans`.

1. Alembic migration: `articles`, `refresh_evaluations`, `runs.article_id`, `runs.triggered_by_evaluation_id`, inline backfill, tests.
2. SQLAlchemy + Pydantic models in `content_tool/db/models.py` and `content_tool/api/schemas.py`.
3. `content_tool/refresh/inventory.py` — upsert-by-URL, schedule math, unit tests.
4. `content_tool/refresh/deterministic_checks.py` — checks + golden-fixture unit tests.
5. `content_tool/refresh/evaluator.py` — `compute_staleness`, LLM-audit wrapper, unit tests.
6. `content_tool/refresh/scanner.py` — `scan_article`, `scan_tick`, advisory lock, supersede-then-insert, module + integration tests.
7. `scripts/refresh_scan.py` — CLI entrypoint.
8. `content_tool/api/routes/articles.py` — list/detail/dismiss endpoints.
9. `content_tool/api/routes/refresh.py` — scan + evaluation endpoints.
10. Patch `routes/runs.py` to accept `triggered_by_evaluation_id` and to upsert `articles.article_id` on Run trigger.
11. `web/app/library/page.tsx` + new components (`LibraryTable`, `StalenessIndicator`, `RefreshFindingsPanel`, `DismissDialog`, `ArticleDetailDrawer`). Add shadcn `calendar` + `sheet`.
12. `web/app/runs/new/page.tsx` patch for prefill + Refresh-context card.
13. Top-bar nav with "Library" link in `app/layout.tsx`.
14. Cost-meter integration (`kind="refresh_scan"`) + new dashboard tile.
15. `deploy/cron/refresh.cron` template + ops note.
16. Playwright tests for `/library` and `/runs/new` context card.
