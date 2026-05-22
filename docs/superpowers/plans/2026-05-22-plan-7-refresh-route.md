# Plan 7 — CMS Stage 0: Refresh Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prereq:** Plans 1–6 shipped — full Update-route backend + UI is live.

**Spec:** [`docs/superpowers/specs/2026-05-22-cms-stage-0-refresh-route-design.md`](../specs/2026-05-22-cms-stage-0-refresh-route-design.md) (commit `9f8408d`)

**Goal:** Ship the Refresh route — a queue-only monitor that periodically re-audits onboarded Bowtie articles and surfaces a prioritised "needs refresh" list at `/library`. Introduces `Article` as a first-class entity. Editor-driven: clicking a queue row pre-fills the existing `/runs/new` Update form. No auto-trigger.

**Architecture:** New Python module `content_tool/refresh/` with four files (`inventory.py`, `deterministic_checks.py`, `evaluator.py`, `scanner.py`). One CLI entrypoint `scripts/refresh_scan.py` invoked by cron. Two new FastAPI route modules (`articles.py`, `refresh.py`). Two new SQLAlchemy tables (`articles`, `refresh_evaluations`) plus two columns on `runs`. New Next.js `/library` page with five reusable components. `WordPressClient` gains a `fetch_post_by_url` method (extracted from `fetch_article.py` node so both call-sites share it).

**Tech Stack:** (no new top-level deps)
- Python 3.13, FastAPI, SQLAlchemy 2.0 async, asyncpg, Alembic
- httpx (link-checker), beautifulsoup4 (HTML parsing for det checks)
- Existing Gemini client (reused for LLM re-audit)
- Postgres advisory locks (tick exclusivity)
- Next.js 15 / React 19 / TypeScript / Tailwind / shadcn (`calendar` + `sheet` to add)
- React Query + sonner (existing)
- pytest + pytest-asyncio + testcontainers + respx + Playwright (existing)

---

## File structure

```
ai_content_tool_2/
├── config/
│   └── refresh.yaml                                # NEW
├── content_tool/
│   ├── config.py                                   # MODIFY (add REFRESH_* settings)
│   ├── refresh/
│   │   ├── __init__.py                             # NEW
│   │   ├── inventory.py                            # NEW (upsert + schedule math)
│   │   ├── deterministic_checks.py                 # NEW (broken links, dated phrasing, FAQ JSON-LD, drift)
│   │   ├── evaluator.py                            # NEW (compute_staleness, LLM-audit wrapper)
│   │   └── scanner.py                              # NEW (scan_article, scan_tick, advisory lock)
│   ├── wordpress/
│   │   └── client.py                               # MODIFY (add fetch_post_by_url)
│   ├── agents/
│   │   └── fetch_article.py                        # MODIFY (call client.fetch_post_by_url)
│   ├── db/
│   │   └── models.py                               # MODIFY (Article, RefreshEvaluation, runs.* cols)
│   ├── api/
│   │   ├── main.py                                 # MODIFY (include new routers)
│   │   ├── schemas.py                              # MODIFY (ArticleOut, RefreshEvaluationOut, etc.)
│   │   └── routes/
│   │       ├── articles.py                         # NEW (list, detail, dismiss)
│   │       ├── refresh.py                          # NEW (scan, scan/{id}, evaluations/{id})
│   │       ├── runs.py                             # MODIFY (accept triggered_by_evaluation_id; upsert article)
│   │       └── costs.py                            # MODIFY (refresh_scan tile data)
├── scripts/
│   ├── __init__.py                                 # NEW (if absent)
│   └── refresh_scan.py                             # NEW (CLI entrypoint)
├── migrations/versions/
│   └── 0006_refresh_route.py                       # NEW (articles, refresh_evaluations, runs cols, backfill)
├── deploy/
│   └── cron/
│       └── refresh.cron                            # NEW (placeholder template)
├── tests/
│   ├── unit/
│   │   ├── test_refresh_deterministic_checks.py    # NEW
│   │   ├── test_refresh_compute_staleness.py       # NEW
│   │   ├── test_refresh_schedule_math.py           # NEW
│   │   └── test_wp_client_fetch.py                 # NEW
│   ├── integration/
│   │   ├── test_refresh_scan_article.py            # NEW (single-article scan with respx + fake Gemini)
│   │   ├── test_refresh_scan_tick.py               # NEW (multi-article tick + advisory lock + supersede)
│   │   ├── test_refresh_api_articles.py            # NEW (list/detail/dismiss endpoints)
│   │   ├── test_refresh_api_scan.py                # NEW (/refresh/scan endpoints)
│   │   ├── test_refresh_click_through.py           # NEW (POST /runs with triggered_by_evaluation_id)
│   │   └── test_refresh_migration_backfill.py      # NEW (Alembic upgrade against seeded data)
│   └── fixtures/
│       ├── wp_responses/
│       │   ├── post_by_slug.json                   # NEW (single-post fetch via /posts?slug=)
│       │   └── post_404.json                       # NEW (empty array — not-found shape)
│       ├── html/
│       │   ├── article_ok.html                     # NEW (passes all det checks)
│       │   ├── article_broken_links.html           # NEW (3 broken outbound links)
│       │   ├── article_dated_phrasing.html         # NEW ("as of 2022", year refs)
│       │   ├── article_missing_faq_jsonld.html     # NEW (has FAQ shortcode, no JSON-LD)
│       │   └── article_drift.html                  # NEW (broken heading nesting)
│       └── gemini_responses/
│           └── audit_refresh_ok.json               # NEW (canned LLM audit for refresh tests)
└── web/
    ├── app/
    │   ├── layout.tsx                              # MODIFY (top-bar nav with Library link)
    │   ├── library/
    │   │   └── page.tsx                            # NEW
    │   └── runs/
    │       └── new/
    │           └── page.tsx                        # MODIFY (accept ?article_id ?evaluation_id)
    ├── components/
    │   ├── LibraryTable.tsx                        # NEW
    │   ├── StalenessIndicator.tsx                  # NEW
    │   ├── RefreshFindingsPanel.tsx                # NEW
    │   ├── DismissDialog.tsx                       # NEW
    │   ├── ArticleDetailDrawer.tsx                 # NEW
    │   └── ui/
    │       ├── calendar.tsx                        # NEW (shadcn add)
    │       └── sheet.tsx                           # NEW (shadcn add)
    ├── lib/
    │   ├── types.ts                                # MODIFY (Article, RefreshEvaluation types)
    │   └── api.ts                                  # MODIFY (articles + refresh endpoints)
    └── tests/
        ├── library.spec.ts                         # NEW
        └── refresh-context.spec.ts                 # NEW
```

---

### Task 1: Refresh config + env vars

**Files:**
- Create: `config/refresh.yaml`
- Modify: `content_tool/config.py`, `.env.example`
- Test: `tests/unit/test_config.py` (extend existing)

- [ ] **Step 1: Create `config/refresh.yaml`**

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

- [ ] **Step 2: Add config loader + env vars to `content_tool/config.py`**

Append to `Settings`:

```python
class Settings(BaseSettings):
    # ... existing fields ...
    refresh_config_path: str = "config/refresh.yaml"
    refresh_cron_enabled: bool = True
```

Add a module-level loader (mirrors `source_policy` pattern):

```python
from pathlib import Path
import yaml

@lru_cache(maxsize=1)
def get_refresh_config() -> dict[str, Any]:
    settings = get_settings()
    path = Path(settings.refresh_config_path)
    if not path.exists():
        raise FileNotFoundError(f"refresh config not found: {path}")
    with path.open() as f:
        return yaml.safe_load(f)
```

- [ ] **Step 3: Append to `.env.example`**

```bash
# Refresh route
REFRESH_CONFIG_PATH=config/refresh.yaml
REFRESH_CRON_ENABLED=true
```

- [ ] **Step 4: Write the failing test**

In `tests/unit/test_config.py`, add:

```python
def test_get_refresh_config_loads_yaml():
    from content_tool.config import get_refresh_config
    cfg = get_refresh_config()
    assert cfg["scheduling"]["default_interval_days"] == 30
    assert cfg["scan"]["llm_cap_per_tick"] == 20
    assert cfg["scoring"]["refresh_threshold"] == 6.0
    assert "facebook.com" in cfg["deterministic"]["link_check_ignore_domains"]
```

- [ ] **Step 5: Run test**

```
uv run pytest tests/unit/test_config.py::test_get_refresh_config_loads_yaml -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/refresh.yaml content_tool/config.py .env.example tests/unit/test_config.py
git commit -m "feat(config): refresh route settings + refresh.yaml"
```

---

### Task 2: SQLAlchemy models — Article + RefreshEvaluation + Run additions

**Files:**
- Modify: `content_tool/db/models.py`
- Test: `tests/unit/test_state_shape.py` (extend) or new `tests/unit/test_models_refresh.py`

- [ ] **Step 1: Add `Article` and `RefreshEvaluation` classes + extend `Run`**

Append to `content_tool/db/models.py` (preserve existing import block; add `Numeric` import):

```python
from sqlalchemy import Numeric  # add to existing imports

class Article(Base):
    __tablename__ = "articles"
    __table_args__ = (
        Index("articles_next_scan_due_idx", "next_scan_due_at"),
        Index("articles_wp_post_id_idx", "wp_post_id"),
        UniqueConstraint("article_url", name="articles_article_url_uidx"),
        {"schema": "content_tool"},
    )

    article_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    article_url: Mapped[str] = mapped_column(String, nullable=False)
    wp_post_id: Mapped[int | None]
    topic: Mapped[str | None] = mapped_column(String)
    persona: Mapped[str | None] = mapped_column(String)
    topic_category: Mapped[str | None] = mapped_column(String)
    first_seen_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    last_persisted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    next_scan_due_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    dismissed_until: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    dismissed_by: Mapped[str | None] = mapped_column(String)
    dismissed_reason: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))

class RefreshEvaluation(Base):
    __tablename__ = "refresh_evaluations"
    __table_args__ = (
        Index("refresh_evals_article_evaluated_idx", "article_id", "evaluated_at"),
        {"schema": "content_tool"},
    )

    evaluation_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    article_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.articles.article_id", ondelete="CASCADE"),
        nullable=False,
    )
    evaluated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    scanner_version: Mapped[str] = mapped_column(String, nullable=False)
    trigger_source: Mapped[str] = mapped_column(String, nullable=False)
    age_days: Mapped[int] = mapped_column(Integer, nullable=False)
    fetched_html_hash: Mapped[str | None] = mapped_column(String)
    deterministic_findings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    llm_findings: Mapped[dict | None] = mapped_column(JSONB)
    llm_skipped_reason: Mapped[str | None] = mapped_column(String)
    staleness_score: Mapped[Decimal] = mapped_column(Numeric(4, 2), nullable=False)
    recommended_action: Mapped[str] = mapped_column(String, nullable=False)
    outcome: Mapped[str] = mapped_column(String, nullable=False, server_default=text("'open'"))
    resulting_run_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("content_tool.runs.run_id")
    )
    outcome_set_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    outcome_set_by: Mapped[str | None] = mapped_column(String)
    tokens_in: Mapped[int | None]
    tokens_out: Mapped[int | None]
    est_cost_usd_cents: Mapped[int | None]
    latency_ms: Mapped[int | None]
```

Also add to existing `Run` class:

```python
class Run(Base):
    # ... existing fields ...
    article_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("content_tool.articles.article_id")
    )
    triggered_by_evaluation_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("content_tool.refresh_evaluations.evaluation_id")
    )
```

Add `Decimal` import at top of the file if not present:

```python
from decimal import Decimal
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/test_models_refresh.py`:

```python
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from content_tool.db.models import Article, RefreshEvaluation, Run

def test_article_instantiation():
    a = Article(
        article_url="https://bowtie.com.hk/vhis/premium-guide",
        next_scan_due_at=datetime.now(timezone.utc),
    )
    assert a.article_url == "https://bowtie.com.hk/vhis/premium-guide"
    assert a.wp_post_id is None

def test_refresh_evaluation_required_fields():
    eid = uuid4()
    aid = uuid4()
    ev = RefreshEvaluation(
        evaluation_id=eid,
        article_id=aid,
        scanner_version="scanner@0.1.0",
        trigger_source="cron",
        age_days=120,
        deterministic_findings={"findings": [], "severity_high": 0, "severity_medium": 0, "severity_low": 0, "passed": True},
        staleness_score=Decimal("4.20"),
        recommended_action="monitor",
        outcome="open",
    )
    assert ev.recommended_action == "monitor"

def test_run_has_new_columns():
    r = Run(
        created_by="editor@bowtie.local",
        status="pending",
        article_url="x", topic="x", keywords=[], mode="small_refresh",
        acf_adv_id=0, acf_widget_id=0, persona="default",
        today_date=datetime.now(timezone.utc).date(),
        article_id=uuid4(),
        triggered_by_evaluation_id=uuid4(),
    )
    assert r.article_id is not None
    assert r.triggered_by_evaluation_id is not None
```

- [ ] **Step 3: Run tests**

```
uv run pytest tests/unit/test_models_refresh.py -v
```

Expected: PASS (no DB needed — instantiation only).

- [ ] **Step 4: Commit**

```bash
git add content_tool/db/models.py tests/unit/test_models_refresh.py
git commit -m "feat(db): Article and RefreshEvaluation models; runs.article_id + triggered_by_evaluation_id"
```

---

### Task 3: Alembic migration `0006_refresh_route.py`

**Files:**
- Create: `migrations/versions/0006_refresh_route.py`
- Test: `tests/integration/test_refresh_migration_backfill.py`

- [ ] **Step 1: Generate empty revision skeleton**

```bash
uv run alembic revision -m "refresh route: articles + refresh_evaluations + runs cols"
# Rename the produced file to 0006_refresh_route.py
mv migrations/versions/*refresh_route*.py migrations/versions/0006_refresh_route.py
```

Edit the new file's `down_revision` to point at `"0005"`.

- [ ] **Step 2: Implement `upgrade()` and `downgrade()`**

Replace the file body with:

```python
"""refresh route: articles + refresh_evaluations + runs cols

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-22
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "articles",
        sa.Column("article_id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("article_url", sa.Text, nullable=False),
        sa.Column("wp_post_id", sa.Integer),
        sa.Column("topic", sa.Text),
        sa.Column("persona", sa.Text),
        sa.Column("topic_category", sa.Text),
        sa.Column("first_seen_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("last_persisted_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("next_scan_due_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("dismissed_until", sa.TIMESTAMP(timezone=True)),
        sa.Column("dismissed_by", sa.Text),
        sa.Column("dismissed_reason", sa.Text),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
        schema="content_tool",
    )
    op.create_index("articles_article_url_uidx", "articles", ["article_url"], unique=True, schema="content_tool")
    op.create_index(
        "articles_next_scan_due_idx", "articles", ["next_scan_due_at"],
        postgresql_where=sa.text("dismissed_until IS NULL OR dismissed_until < now()"),
        schema="content_tool",
    )
    op.create_index(
        "articles_wp_post_id_idx", "articles", ["wp_post_id"],
        postgresql_where=sa.text("wp_post_id IS NOT NULL"),
        schema="content_tool",
    )

    op.create_table(
        "refresh_evaluations",
        sa.Column("evaluation_id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("article_id", UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.articles.article_id", ondelete="CASCADE"), nullable=False),
        sa.Column("evaluated_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("scanner_version", sa.Text, nullable=False),
        sa.Column("trigger_source", sa.Text, nullable=False),
        sa.Column("age_days", sa.Integer, nullable=False),
        sa.Column("fetched_html_hash", sa.Text),
        sa.Column("deterministic_findings", JSONB, nullable=False),
        sa.Column("llm_findings", JSONB),
        sa.Column("llm_skipped_reason", sa.Text),
        sa.Column("staleness_score", sa.Numeric(4, 2), nullable=False),
        sa.Column("recommended_action", sa.Text, nullable=False),
        sa.Column("outcome", sa.Text, nullable=False, server_default=sa.text("'open'")),
        sa.Column("resulting_run_id", UUID(as_uuid=True), sa.ForeignKey("content_tool.runs.run_id")),
        sa.Column("outcome_set_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("outcome_set_by", sa.Text),
        sa.Column("tokens_in", sa.Integer),
        sa.Column("tokens_out", sa.Integer),
        sa.Column("est_cost_usd_cents", sa.Integer),
        sa.Column("latency_ms", sa.Integer),
        schema="content_tool",
    )
    op.create_index(
        "refresh_evals_article_evaluated_idx", "refresh_evaluations",
        ["article_id", sa.text("evaluated_at DESC")],
        schema="content_tool",
    )
    op.create_index(
        "refresh_evals_open_idx", "refresh_evaluations", ["recommended_action", "outcome"],
        postgresql_where=sa.text("outcome = 'open' AND recommended_action = 'refresh'"),
        schema="content_tool",
    )

    op.add_column("runs",
        sa.Column("article_id", UUID(as_uuid=True), sa.ForeignKey("content_tool.articles.article_id")),
        schema="content_tool")
    op.add_column("runs",
        sa.Column("triggered_by_evaluation_id", UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.refresh_evaluations.evaluation_id")),
        schema="content_tool")
    op.create_index("runs_article_id_idx", "runs", ["article_id"], schema="content_tool")

    # Backfill: one Article per distinct runs.article_url
    op.execute("""
        INSERT INTO content_tool.articles
            (article_url, wp_post_id, topic, persona, topic_category,
             first_seen_at, last_persisted_at, next_scan_due_at)
        SELECT
            article_url,
            MAX(wp_post_id),
            MAX(topic),
            MAX(persona),
            MAX(topic_category),
            MIN(first_seen),
            MAX(last_persisted),
            COALESCE(MAX(last_persisted), now()) + INTERVAL '30 days'
        FROM (
            SELECT
                r.article_url,
                fa.wp_post_id,
                r.topic,
                r.persona,
                r.topic_category,
                r.created_at AS first_seen,
                cl.persisted_at AS last_persisted
            FROM content_tool.runs r
            LEFT JOIN content_tool.fetched_articles fa ON fa.run_id = r.run_id
            LEFT JOIN content_tool.compliance_log cl ON cl.run_id = r.run_id
        ) src
        GROUP BY article_url
        ON CONFLICT (article_url) DO NOTHING;
    """)
    op.execute("""
        UPDATE content_tool.runs r
        SET article_id = a.article_id
        FROM content_tool.articles a
        WHERE a.article_url = r.article_url
          AND r.article_id IS NULL;
    """)


def downgrade() -> None:
    op.drop_index("runs_article_id_idx", table_name="runs", schema="content_tool")
    op.drop_column("runs", "triggered_by_evaluation_id", schema="content_tool")
    op.drop_column("runs", "article_id", schema="content_tool")
    op.drop_index("refresh_evals_open_idx", table_name="refresh_evaluations", schema="content_tool")
    op.drop_index("refresh_evals_article_evaluated_idx", table_name="refresh_evaluations", schema="content_tool")
    op.drop_table("refresh_evaluations", schema="content_tool")
    op.drop_index("articles_wp_post_id_idx", table_name="articles", schema="content_tool")
    op.drop_index("articles_next_scan_due_idx", table_name="articles", schema="content_tool")
    op.drop_index("articles_article_url_uidx", table_name="articles", schema="content_tool")
    op.drop_table("articles", schema="content_tool")
```

- [ ] **Step 3: Write the failing integration test**

Create `tests/integration/test_refresh_migration_backfill.py`:

```python
from datetime import datetime, timezone
import pytest
from sqlalchemy import text

@pytest.mark.asyncio
async def test_backfill_populates_articles_and_runs_links(pg_session_factory_pre_migration):
    """Seeds pre-0006 data, runs upgrade, asserts backfill linked Runs."""
    # `pg_session_factory_pre_migration` is a conftest fixture that:
    # 1. Starts a testcontainer postgres
    # 2. Runs migrations up to 0005 only
    # 3. Seeds 2 distinct article_urls across 3 runs + 1 compliance_log row
    # 4. Returns a session factory bound to the engine
    # 5. After test, the test calls `alembic upgrade 0006` to run our migration
    sf = pg_session_factory_pre_migration
    async with sf() as s:
        # Seed: 3 runs, 2 distinct urls
        await s.execute(text("""
            INSERT INTO content_tool.runs
                (run_id, created_by, status, article_url, topic, keywords, mode,
                 acf_adv_id, acf_widget_id, persona, today_date, iteration_count)
            VALUES
                (gen_random_uuid(), 'e', 'persisted', 'https://bowtie/a', 'A', '[]', 'small_refresh', 0, 0, 'family', current_date, 0),
                (gen_random_uuid(), 'e', 'persisted', 'https://bowtie/a', 'A', '[]', 'small_refresh', 0, 0, 'family', current_date, 1),
                (gen_random_uuid(), 'e', 'persisted', 'https://bowtie/b', 'B', '[]', 'full_rewrite', 0, 0, 'retiree', current_date, 0);
        """))
        await s.commit()

    # Run the upgrade
    from alembic.config import Config
    from alembic import command
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "0006")

    async with sf() as s:
        rows = (await s.execute(text("SELECT COUNT(*) FROM content_tool.articles"))).scalar_one()
        assert rows == 2
        linked = (await s.execute(text("SELECT COUNT(*) FROM content_tool.runs WHERE article_id IS NOT NULL"))).scalar_one()
        assert linked == 3
```

If the `pg_session_factory_pre_migration` fixture does not already exist in `tests/conftest.py`, add it now:

```python
# tests/conftest.py — add a pre-migration fixture
@pytest.fixture
async def pg_session_factory_pre_migration():
    """Starts pg testcontainer, runs migrations up to 0005, yields session factory."""
    from testcontainers.postgres import PostgresContainer
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from alembic.config import Config
    from alembic import command
    with PostgresContainer("postgres:16") as pg:
        url = pg.get_connection_url().replace("postgresql+psycopg2", "postgresql+asyncpg")
        engine = create_async_engine(url)
        async with engine.begin() as conn:
            await conn.execute(text("CREATE SCHEMA IF NOT EXISTS content_tool"))
        cfg = Config("alembic.ini")
        cfg.set_main_option("sqlalchemy.url", url.replace("+asyncpg", "+psycopg2"))
        command.upgrade(cfg, "0005")
        sf = async_sessionmaker(engine, expire_on_commit=False)
        yield sf
        await engine.dispose()
```

- [ ] **Step 4: Run the test**

```
uv run pytest tests/integration/test_refresh_migration_backfill.py -v
```

Expected: PASS. If the fixture doesn't quite match the existing conftest pattern, look at the existing `pg_session_factory` fixture and mirror its approach for setting up the engine.

- [ ] **Step 5: Run all migrations forward + back to verify down**

```
uv run alembic upgrade head
uv run alembic downgrade -1
uv run alembic upgrade head
```

Expected: all succeed.

- [ ] **Step 6: Commit**

```bash
git add migrations/versions/0006_refresh_route.py tests/integration/test_refresh_migration_backfill.py tests/conftest.py
git commit -m "feat(db): alembic 0006 — refresh tables + backfill"
```

---

### Task 4: API schemas — Pydantic types

**Files:**
- Modify: `content_tool/api/schemas.py`

- [ ] **Step 1: Add new Pydantic models**

Append to `content_tool/api/schemas.py`:

```python
from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, Field

class RefreshEvaluationOut(BaseModel):
    evaluation_id: UUID
    evaluated_at: datetime
    age_days: int
    staleness_score: Decimal
    recommended_action: Literal["refresh", "monitor", "ok"]
    deterministic_findings: dict
    llm_findings: dict | None = None
    llm_skipped_reason: str | None = None
    outcome: Literal["open", "triggered", "dismissed", "superseded"]
    resulting_run_id: UUID | None = None

class ArticleOut(BaseModel):
    article_id: UUID
    article_url: str
    wp_post_id: int | None = None
    topic: str | None = None
    persona: str | None = None
    topic_category: str | None = None
    first_seen_at: datetime
    last_persisted_at: datetime | None = None
    next_scan_due_at: datetime
    dismissed_until: datetime | None = None
    latest_evaluation: RefreshEvaluationOut | None = None
    open_runs_count: int = 0

class ArticleListResponse(BaseModel):
    items: list[ArticleOut]
    total: int

class ArticleDetailOut(ArticleOut):
    recent_evaluations: list[RefreshEvaluationOut] = Field(default_factory=list)
    recent_run_ids: list[UUID] = Field(default_factory=list)

class DismissRequest(BaseModel):
    until: datetime
    reason: str | None = None
    dismissed_by: str

class ScanRequest(BaseModel):
    article_ids: list[UUID] | None = None
    force: bool = False

class ScanResponse(BaseModel):
    tick_id: UUID
    scanned: int
    evaluations_created: int
    llm_calls: int
    est_cost_usd_cents: int
    started_at: datetime
    finished_at: datetime
    skipped: list[dict]  # [{ "article_id": UUID, "reason": str }]
```

- [ ] **Step 2: Verify imports load**

```
uv run python -c "from content_tool.api.schemas import ArticleOut, ScanResponse; print('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add content_tool/api/schemas.py
git commit -m "feat(api): refresh route Pydantic schemas"
```

---

### Task 5: WordPressClient — `fetch_post_by_url`

**Files:**
- Modify: `content_tool/wordpress/client.py`
- Modify: `content_tool/agents/fetch_article.py` (use new client method)
- Test: `tests/unit/test_wp_client_fetch.py`

- [ ] **Step 1: Add `FetchedPost` dataclass + method**

In `content_tool/wordpress/client.py`, add near the existing dataclasses:

```python
from urllib.parse import urlparse

@dataclass
class FetchedPost:
    id: int
    slug: str
    link: str
    title: str
    content_html: str
    modified_gmt: str
    status: str
    author: int | None
    categories: list[int]
```

Add this method to `WordPressClient` (after `upsert`):

```python
async def fetch_post_by_url(self, article_url: str) -> FetchedPost | None:
    """Resolve a WordPress post by its public URL. Returns None if not found.

    Strategy: extract the trailing slug from the URL path, then call
    GET /wp/v2/posts?slug=<slug>&_fields=...
    """
    parsed = urlparse(article_url)
    slug = parsed.path.rstrip("/").rsplit("/", 1)[-1]
    if not slug:
        return None

    async with httpx.AsyncClient(timeout=self._timeout) as client:
        resp = await client.get(
            f"{self._base_url}/wp-json/wp/v2/posts",
            params={
                "slug": slug,
                "_fields": "id,slug,link,title,content,modified_gmt,status,author,categories",
                "status": "publish",
            },
            headers={"Authorization": f"Basic {self._auth_header()}"},
        )
        resp.raise_for_status()
        posts = resp.json()
        if not posts:
            return None
        p = posts[0]
        return FetchedPost(
            id=int(p["id"]),
            slug=p["slug"],
            link=p["link"],
            title=p["title"]["rendered"],
            content_html=p["content"]["rendered"],
            modified_gmt=p["modified_gmt"],
            status=p["status"],
            author=p.get("author"),
            categories=list(p.get("categories", [])),
        )
```

- [ ] **Step 2: Refactor `fetch_article.py` to use the new method**

Open `content_tool/agents/fetch_article.py`. Replace the inline WP HTTP call (the section that does `client.get(f"{wp_base}/posts?slug=…")` or equivalent) with:

```python
post = await wp_client.fetch_post_by_url(article_url)
if post is None:
    raise ValueError(f"WP post not found for {article_url}")
# downstream code: use post.id, post.content_html (renamed from rendered), post.categories
```

Existing downstream code reads `post["id"]`, `post["content"]["rendered"]`, `post.get("categories", [])`. Update to `post.id`, `post.content_html`, `post.categories`. Markdownify the html as before.

- [ ] **Step 3: Write the failing test**

Create `tests/unit/test_wp_client_fetch.py`:

```python
import json
from pathlib import Path
import httpx
import pytest
import respx
from content_tool.wordpress.client import WordPressClient, FetchedPost

@pytest.fixture
def wp_client():
    return WordPressClient(
        base_url="https://wp.test", username="u", app_password="p", timeout=5.0,
    )

@respx.mock
@pytest.mark.asyncio
async def test_fetch_post_by_url_returns_fetched_post(wp_client):
    fixture = json.loads(Path("tests/fixtures/wp_responses/post_by_slug.json").read_text())
    respx.get(
        "https://wp.test/wp-json/wp/v2/posts",
        params={"slug": "premium-guide", "status": "publish",
                "_fields": "id,slug,link,title,content,modified_gmt,status,author,categories"},
    ).mock(return_value=httpx.Response(200, json=fixture))

    post = await wp_client.fetch_post_by_url("https://bowtie.com.hk/vhis/premium-guide/")
    assert isinstance(post, FetchedPost)
    assert post.id == 1234
    assert post.slug == "premium-guide"
    assert "<h2>" in post.content_html

@respx.mock
@pytest.mark.asyncio
async def test_fetch_post_by_url_returns_none_when_empty_array(wp_client):
    respx.get("https://wp.test/wp-json/wp/v2/posts").mock(
        return_value=httpx.Response(200, json=[])
    )
    post = await wp_client.fetch_post_by_url("https://bowtie.com.hk/no-such-slug/")
    assert post is None
```

Create the fixture `tests/fixtures/wp_responses/post_by_slug.json`:

```json
[
  {
    "id": 1234,
    "slug": "premium-guide",
    "link": "https://bowtie.com.hk/vhis/premium-guide/",
    "title": {"rendered": "VHIS Premium Guide"},
    "content": {"rendered": "<h2>Section 1</h2><p>As of 2022, premiums…</p>"},
    "modified_gmt": "2025-11-01T03:14:00",
    "status": "publish",
    "author": 5,
    "categories": [12, 34]
  }
]
```

Create `tests/fixtures/wp_responses/post_404.json`:

```json
[]
```

- [ ] **Step 4: Run tests**

```
uv run pytest tests/unit/test_wp_client_fetch.py -v
```

Expected: both PASS.

- [ ] **Step 5: Run existing fetch_article tests to confirm no regression**

```
uv run pytest tests/integration/test_fetch_article_node.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add content_tool/wordpress/client.py content_tool/agents/fetch_article.py tests/unit/test_wp_client_fetch.py tests/fixtures/wp_responses/post_by_slug.json tests/fixtures/wp_responses/post_404.json
git commit -m "feat(wp): WordPressClient.fetch_post_by_url; refactor fetch_article to use it"
```

---

### Task 6: Inventory module — schedule math + article upsert

**Files:**
- Create: `content_tool/refresh/__init__.py` (empty)
- Create: `content_tool/refresh/inventory.py`
- Test: `tests/unit/test_refresh_schedule_math.py`

- [ ] **Step 1: Create `content_tool/refresh/__init__.py`**

```python
"""Refresh route — periodic re-audit of onboarded WordPress articles."""
```

- [ ] **Step 2: Create `content_tool/refresh/inventory.py`**

```python
"""Article-table maintenance: upsert by URL, schedule advancement math."""
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.config import get_refresh_config
from content_tool.db.models import Article


async def upsert_article(
    session: AsyncSession,
    *,
    article_url: str,
    topic: str | None = None,
    persona: str | None = None,
    topic_category: str | None = None,
    wp_post_id: int | None = None,
    last_persisted_at: datetime | None = None,
) -> Article:
    """Insert-or-update by article_url. Sets next_scan_due_at on first insert only."""
    cfg = get_refresh_config()["scheduling"]
    default_due = (last_persisted_at or datetime.now(timezone.utc)) + timedelta(
        days=cfg["default_interval_days"]
    )

    stmt = pg_insert(Article).values(
        article_url=article_url,
        topic=topic,
        persona=persona,
        topic_category=topic_category,
        wp_post_id=wp_post_id,
        last_persisted_at=last_persisted_at,
        next_scan_due_at=default_due,
    ).on_conflict_do_update(
        index_elements=["article_url"],
        set_={
            "topic": pg_insert(Article).excluded.topic,
            "persona": pg_insert(Article).excluded.persona,
            "topic_category": pg_insert(Article).excluded.topic_category,
            "wp_post_id": pg_insert(Article).excluded.wp_post_id,
            "updated_at": datetime.now(timezone.utc),
        },
    ).returning(Article)

    row = (await session.execute(stmt)).scalar_one()
    return row


def advance_schedule(
    *,
    action: str,                          # "refresh" | "monitor" | "ok"
    now: datetime | None = None,
) -> datetime | None:
    """Return new next_scan_due_at. None means caller should leave it untouched."""
    cfg = get_refresh_config()["scheduling"]
    now = now or datetime.now(timezone.utc)
    if action == "refresh":
        return None                       # leave overdue
    if action == "monitor":
        return now + timedelta(days=cfg["monitor_interval_days"])
    if action == "ok":
        return now + timedelta(days=cfg["ok_interval_days"])
    raise ValueError(f"unknown action: {action!r}")


def schedule_after_retry(now: datetime | None = None) -> datetime:
    cfg = get_refresh_config()["scheduling"]
    now = now or datetime.now(timezone.utc)
    return now + timedelta(days=cfg["retry_interval_days"])


def schedule_after_dismiss(dismissed_until: datetime) -> datetime:
    """Per spec §5.1: set next_scan_due_at = dismissed_until so the row becomes due
    the moment dismissal expires."""
    return dismissed_until
```

- [ ] **Step 3: Write the failing test**

Create `tests/unit/test_refresh_schedule_math.py`:

```python
from datetime import datetime, timedelta, timezone
import pytest
from content_tool.refresh.inventory import (
    advance_schedule, schedule_after_retry, schedule_after_dismiss,
)

NOW = datetime(2026, 5, 22, 12, 0, tzinfo=timezone.utc)

def test_advance_schedule_refresh_returns_none():
    assert advance_schedule(action="refresh", now=NOW) is None

def test_advance_schedule_monitor_returns_now_plus_14_days():
    assert advance_schedule(action="monitor", now=NOW) == NOW + timedelta(days=14)

def test_advance_schedule_ok_returns_now_plus_30_days():
    assert advance_schedule(action="ok", now=NOW) == NOW + timedelta(days=30)

def test_advance_schedule_unknown_raises():
    with pytest.raises(ValueError):
        advance_schedule(action="bogus", now=NOW)

def test_schedule_after_retry_is_one_day():
    assert schedule_after_retry(now=NOW) == NOW + timedelta(days=1)

def test_schedule_after_dismiss_is_dismissed_until():
    until = NOW + timedelta(days=7)
    assert schedule_after_dismiss(until) == until
```

- [ ] **Step 4: Run tests**

```
uv run pytest tests/unit/test_refresh_schedule_math.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add content_tool/refresh/__init__.py content_tool/refresh/inventory.py tests/unit/test_refresh_schedule_math.py
git commit -m "feat(refresh): inventory module — upsert article + schedule math"
```

---

### Task 7: Deterministic checks module

**Files:**
- Create: `content_tool/refresh/deterministic_checks.py`
- Test: `tests/unit/test_refresh_deterministic_checks.py`
- Fixtures: `tests/fixtures/html/*.html`

- [ ] **Step 1: Create the fixture HTML files**

`tests/fixtures/html/article_ok.html`:

```html
<h2>Premium guide</h2>
<p>As of <a href="https://bowtie.com.hk/about/">2025</a>, VHIS premiums…</p>
<p>See <a href="https://www.ia.org.hk/">IA</a> guidance.</p>
[acf_widget id="42"]
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage"}</script>
```

`tests/fixtures/html/article_broken_links.html`:

```html
<h2>Heading</h2>
<p>Old link <a href="https://broken.example.invalid/page">here</a> and
   <a href="https://another-broken.invalid">there</a> and
   <a href="https://yet-another.invalid">again</a>.</p>
```

`tests/fixtures/html/article_dated_phrasing.html`:

```html
<h2>Old</h2>
<p>As of 2022, the premium was HK$1,000. By 2021, regulations changed.</p>
```

`tests/fixtures/html/article_missing_faq_jsonld.html`:

```html
<h2>FAQs</h2>
<div class="bowtie-faq">[acf_widget id="99"]</div>
<p>Q: How much? A: A lot.</p>
```

`tests/fixtures/html/article_drift.html`:

```html
<h2>Outer</h2>
<h4>Skipped h3</h4>
<p>Body without disclaimer.</p>
```

- [ ] **Step 2: Create `content_tool/refresh/deterministic_checks.py`**

```python
"""Deterministic checks against currently-published HTML."""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

import httpx
from bs4 import BeautifulSoup

from content_tool.config import get_refresh_config

Severity = Literal["high", "medium", "low"]

@dataclass
class Finding:
    id: str
    severity: Severity
    message: str
    context: dict | None = None

@dataclass
class DeterministicResult:
    findings: list[Finding] = field(default_factory=list)
    severity_high: int = 0
    severity_medium: int = 0
    severity_low: int = 0

    def add(self, f: Finding) -> None:
        self.findings.append(f)
        if f.severity == "high":
            self.severity_high += 1
        elif f.severity == "medium":
            self.severity_medium += 1
        else:
            self.severity_low += 1

    @property
    def passed(self) -> bool:
        cfg = get_refresh_config()["deterministic"]
        return (
            self.severity_high == 0
            and self.severity_medium <= cfg["audit_det_medium_threshold"]
        )

    def to_jsonb(self) -> dict:
        return {
            "findings": [
                {"id": f.id, "severity": f.severity, "message": f.message, "context": f.context}
                for f in self.findings
            ],
            "severity_high": self.severity_high,
            "severity_medium": self.severity_medium,
            "severity_low": self.severity_low,
            "passed": self.passed,
        }


async def check_broken_links(html: str, client: httpx.AsyncClient | None = None) -> list[Finding]:
    cfg = get_refresh_config()["deterministic"]
    soup = BeautifulSoup(html, "html.parser")
    urls: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not href.startswith("http"):
            continue
        if any(dom in href for dom in cfg["link_check_ignore_domains"]):
            continue
        urls.append(href)

    if not urls:
        return []

    sem = asyncio.Semaphore(cfg["link_check_concurrency"])
    findings: list[Finding] = []
    timeout = cfg["link_check_timeout_ms"] / 1000.0
    close_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)

    async def check_one(u: str) -> None:
        async with sem:
            try:
                r = await client.head(u, timeout=timeout)
                if r.status_code >= 400:
                    # Retry as GET — some servers reject HEAD
                    r = await client.get(u, timeout=timeout)
                if r.status_code >= 400:
                    findings.append(Finding(
                        id="det-link-broken", severity="medium",
                        message=f"Broken link: {u} ({r.status_code})", context={"url": u, "status": r.status_code},
                    ))
            except Exception as e:
                findings.append(Finding(
                    id="det-link-broken", severity="medium",
                    message=f"Broken link: {u} ({type(e).__name__})", context={"url": u, "error": str(e)[:200]},
                ))

    try:
        await asyncio.gather(*(check_one(u) for u in urls))
    finally:
        if close_client:
            await client.aclose()
    return findings


def check_dated_phrasing(html: str, now: datetime | None = None) -> list[Finding]:
    cfg = get_refresh_config()["deterministic"]
    now = now or datetime.now()
    lookback = cfg["dated_phrasing_year_lookback"]
    threshold_year = now.year - lookback
    findings: list[Finding] = []
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ")

    for m in re.finditer(r"\bas of (\w+ )?(\d{4})\b", text, re.IGNORECASE):
        year = int(m.group(2))
        if year < threshold_year:
            findings.append(Finding(
                id="det-dated-phrasing", severity="low",
                message=f"Dated phrasing: '{m.group(0)}'", context={"year": year},
            ))
    for m in re.finditer(r"\b(20\d{2})\b", text):
        year = int(m.group(1))
        if year < threshold_year and not re.search(r"as of", text[max(0, m.start() - 8):m.start()], re.IGNORECASE):
            findings.append(Finding(
                id="det-old-year", severity="low",
                message=f"Old year reference: {year}", context={"year": year},
            ))
    return findings


def check_missing_faq_jsonld(html: str) -> list[Finding]:
    has_faq_shortcode = bool(re.search(r"\[acf_widget [^\]]*\]", html)) or "bowtie-faq" in html
    has_faq_jsonld = bool(re.search(r"FAQPage", html))
    if has_faq_shortcode and not has_faq_jsonld:
        return [Finding(
            id="det-missing-faq-jsonld", severity="high",
            message="FAQ widget present but FAQPage JSON-LD missing", context=None,
        )]
    return []


def check_html_drift(html: str) -> list[Finding]:
    """Coarse structural drift detector. Catches obvious skips in heading hierarchy."""
    findings: list[Finding] = []
    soup = BeautifulSoup(html, "html.parser")
    headings = [int(h.name[1]) for h in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"])]
    for prev, cur in zip(headings, headings[1:]):
        if cur > prev + 1:
            findings.append(Finding(
                id="det-heading-skip", severity="medium",
                message=f"Heading skip: h{prev} → h{cur}", context={"prev": prev, "cur": cur},
            ))
            break  # one report per article
    return findings


async def deterministic_audit_published_html(
    html: str,
    *,
    modified_gmt: str | None = None,
    last_persisted_at: datetime | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> DeterministicResult:
    result = DeterministicResult()
    for f in await check_broken_links(html, client=http_client):
        result.add(f)
    for f in check_dated_phrasing(html):
        result.add(f)
    for f in check_missing_faq_jsonld(html):
        result.add(f)
    for f in check_html_drift(html):
        result.add(f)
    return result
```

- [ ] **Step 3: Write the failing test**

Create `tests/unit/test_refresh_deterministic_checks.py`:

```python
from datetime import datetime
from pathlib import Path
import httpx
import pytest
import respx

from content_tool.refresh.deterministic_checks import (
    check_dated_phrasing, check_missing_faq_jsonld, check_html_drift,
    check_broken_links, deterministic_audit_published_html,
)

FIX = Path("tests/fixtures/html")

def load(name: str) -> str:
    return (FIX / name).read_text()

def test_check_dated_phrasing_finds_old_years():
    html = load("article_dated_phrasing.html")
    findings = check_dated_phrasing(html, now=datetime(2026, 5, 22))
    assert any("as of 2022" in f.message.lower() for f in findings)
    assert all(f.severity == "low" for f in findings)

def test_check_dated_phrasing_ok_when_current():
    html = load("article_ok.html")
    findings = check_dated_phrasing(html, now=datetime(2026, 5, 22))
    # The 2025 reference is within lookback=1 (threshold_year=2025), so 2025 is OK
    old = [f for f in findings if f.context and f.context.get("year", 9999) < 2025]
    assert old == []

def test_check_missing_faq_jsonld_flags_when_missing():
    findings = check_missing_faq_jsonld(load("article_missing_faq_jsonld.html"))
    assert len(findings) == 1
    assert findings[0].severity == "high"

def test_check_missing_faq_jsonld_ok_when_present():
    assert check_missing_faq_jsonld(load("article_ok.html")) == []

def test_check_html_drift_catches_h2_to_h4_skip():
    findings = check_html_drift(load("article_drift.html"))
    assert len(findings) == 1
    assert findings[0].severity == "medium"

@respx.mock
@pytest.mark.asyncio
async def test_check_broken_links_flags_4xx():
    respx.head("https://broken.example.invalid/page").mock(return_value=httpx.Response(404))
    respx.head("https://another-broken.invalid").mock(return_value=httpx.Response(404))
    respx.head("https://yet-another.invalid").mock(return_value=httpx.Response(404))
    respx.get("https://broken.example.invalid/page").mock(return_value=httpx.Response(404))
    respx.get("https://another-broken.invalid").mock(return_value=httpx.Response(404))
    respx.get("https://yet-another.invalid").mock(return_value=httpx.Response(404))
    findings = await check_broken_links(load("article_broken_links.html"))
    assert len(findings) == 3
    assert all(f.severity == "medium" for f in findings)

@respx.mock
@pytest.mark.asyncio
async def test_full_audit_ok_html_passes(monkeypatch):
    # Mock outbound link checks to return 200
    respx.head("https://bowtie.com.hk/about/").mock(return_value=httpx.Response(200))
    respx.head("https://www.ia.org.hk/").mock(return_value=httpx.Response(200))
    result = await deterministic_audit_published_html(load("article_ok.html"))
    assert result.passed
    assert result.severity_high == 0
```

- [ ] **Step 4: Run tests**

```
uv run pytest tests/unit/test_refresh_deterministic_checks.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add content_tool/refresh/deterministic_checks.py tests/unit/test_refresh_deterministic_checks.py tests/fixtures/html/
git commit -m "feat(refresh): deterministic checks — broken links, dated phrasing, FAQ JSON-LD, drift"
```

---

### Task 8: Evaluator — compute_staleness + LLM-audit wrapper

**Files:**
- Create: `content_tool/refresh/evaluator.py`
- Test: `tests/unit/test_refresh_compute_staleness.py`

- [ ] **Step 1: Create `content_tool/refresh/evaluator.py`**

```python
"""Composite staleness scoring + LLM-audit wrapper for refresh."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from content_tool.config import get_refresh_config
from content_tool.refresh.deterministic_checks import DeterministicResult

Action = Literal["refresh", "monitor", "ok"]


@dataclass
class LLMFindings:
    severity_high: int = 0
    severity_medium: int = 0
    severity_low: int = 0
    raw: dict | None = None  # full audit response for storage


def compute_staleness(
    det: DeterministicResult,
    llm: LLMFindings | None,
    age_days: int,
) -> tuple[Decimal, Action]:
    cfg = get_refresh_config()["scoring"]

    age_factor = min(10.0, 10.0 * age_days / cfg["age_full_score_days"])

    if llm is None:
        llm_factor = 0.0
    elif llm.severity_high > 0:
        llm_factor = 10.0
    elif llm.severity_medium > 0:
        llm_factor = 5.0
    else:
        llm_factor = 0.0

    raw_score = (
        cfg["age_weight"] * age_factor
        + cfg["det_high_weight"] * det.severity_high * 10.0
        + cfg["det_medium_weight"] * det.severity_medium * 5.0
        + cfg["llm_weight"] * llm_factor
    )
    score = Decimal(f"{max(0.0, min(10.0, raw_score)):.2f}")

    has_high_severity = det.severity_high > 0 or (llm is not None and llm.severity_high > 0)
    if score >= Decimal(str(cfg["refresh_threshold"])) or has_high_severity:
        action = "refresh"
    elif score >= Decimal(str(cfg["monitor_threshold"])):
        action = "monitor"
    else:
        action = "ok"

    return score, action


async def llm_audit_published(
    html: str,
    *,
    persona: str | None,
    gemini_client,                             # type: GeminiClient (existing)
) -> LLMFindings:
    """Run the existing audit prompt against published HTML.

    Reuses content_tool/agents/audit.py prompt builder. Returns LLMFindings
    derived from the audit response; stores full raw audit dict in .raw.
    """
    from content_tool.agents.audit import build_audit_messages, parse_audit_response

    messages = build_audit_messages(markup=html, persona=persona, mode="refresh_published")
    raw = await gemini_client.generate_json(messages, response_schema_name="audit")
    parsed = parse_audit_response(raw)  # existing Pydantic model

    findings = LLMFindings(
        severity_high=sum(1 for f in parsed.findings if f.severity == "high"),
        severity_medium=sum(1 for f in parsed.findings if f.severity == "medium"),
        severity_low=sum(1 for f in parsed.findings if f.severity == "low"),
        raw=parsed.model_dump(mode="json"),
    )
    return findings
```

**Note for engineer:** the call signature of `build_audit_messages` / `parse_audit_response` may differ slightly from the production audit module. Inspect `content_tool/agents/audit.py` and adapt names. If the existing audit module hard-codes `mode="draft_audit"`, either add a `mode` parameter or pass through whatever the existing API supports — the goal is to invoke the same prompt with the published HTML in place of the draft markup. Do **not** introduce a new prompt; reuse what's there.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/test_refresh_compute_staleness.py`:

```python
from decimal import Decimal
import pytest
from content_tool.refresh.deterministic_checks import DeterministicResult, Finding
from content_tool.refresh.evaluator import compute_staleness, LLMFindings


def make_det(high: int = 0, medium: int = 0, low: int = 0) -> DeterministicResult:
    r = DeterministicResult()
    for _ in range(high):
        r.add(Finding(id="x", severity="high", message="x"))
    for _ in range(medium):
        r.add(Finding(id="x", severity="medium", message="x"))
    for _ in range(low):
        r.add(Finding(id="x", severity="low", message="x"))
    return r


def test_fresh_article_no_findings_is_ok():
    score, action = compute_staleness(make_det(), None, age_days=10)
    assert score < Decimal("3.0")
    assert action == "ok"

def test_very_old_article_with_no_findings_is_at_least_monitor():
    score, action = compute_staleness(make_det(), None, age_days=180)
    assert score >= Decimal("3.0")
    assert action in ("monitor", "refresh")

def test_high_severity_det_forces_refresh_regardless_of_score():
    score, action = compute_staleness(make_det(high=1), None, age_days=1)
    assert action == "refresh"

def test_high_severity_llm_forces_refresh():
    llm = LLMFindings(severity_high=1)
    score, action = compute_staleness(make_det(), llm, age_days=1)
    assert action == "refresh"

def test_score_is_clamped_to_10():
    score, _ = compute_staleness(make_det(high=10, medium=10), LLMFindings(severity_high=10), age_days=10000)
    assert score == Decimal("10.00")

def test_monitor_action_at_score_3_to_6():
    # Tune inputs so raw_score ≈ 4: just age signal pushed up
    score, action = compute_staleness(make_det(), None, age_days=140)
    assert Decimal("3.0") <= score < Decimal("6.0")
    assert action == "monitor"
```

- [ ] **Step 3: Run tests**

```
uv run pytest tests/unit/test_refresh_compute_staleness.py -v
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add content_tool/refresh/evaluator.py tests/unit/test_refresh_compute_staleness.py
git commit -m "feat(refresh): compute_staleness + LLM-audit wrapper"
```

---

### Task 9: Scanner — scan_article + scan_tick + advisory lock

**Files:**
- Create: `content_tool/refresh/scanner.py`
- Test: `tests/integration/test_refresh_scan_article.py`
- Test: `tests/integration/test_refresh_scan_tick.py`

- [ ] **Step 1: Create `content_tool/refresh/scanner.py`**

```python
"""Refresh scanner — orchestrates per-article and per-tick scanning."""
from __future__ import annotations

import hashlib
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.config import get_refresh_config
from content_tool.db.models import Article, RefreshEvaluation, Run
from content_tool.refresh.deterministic_checks import deterministic_audit_published_html
from content_tool.refresh.evaluator import LLMFindings, compute_staleness, llm_audit_published
from content_tool.refresh.inventory import advance_schedule, schedule_after_retry
from content_tool.wordpress.client import WordPressClient

log = structlog.get_logger(__name__)

SCANNER_VERSION = "scanner@0.1.0"
TriggerSource = Literal["cron", "manual_api", "manual_per_article"]

IN_FLIGHT_STATUSES = ("pending", "strategy", "hitl_1", "production", "hitl_2", "persisted")


@dataclass
class TickResult:
    tick_id: UUID
    scanned: int = 0
    evaluations_created: int = 0
    llm_calls: int = 0
    est_cost_usd_cents: int = 0
    started_at: datetime | None = None
    finished_at: datetime | None = None
    skipped: list[dict] | None = None

    def __post_init__(self) -> None:
        if self.skipped is None:
            self.skipped = []


@asynccontextmanager
async def _advisory_lock(session: AsyncSession, key: int):
    """pg_try_advisory_lock(key) — non-blocking. Yields True if acquired."""
    got = (await session.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key})).scalar_one()
    try:
        yield bool(got)
    finally:
        if got:
            await session.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})


async def scan_article(
    session: AsyncSession,
    *,
    article: Article,
    wp_client: WordPressClient,
    gemini_client,
    trigger_source: TriggerSource,
    llm_budget_remaining: int,
    tick_id: UUID,
) -> tuple[RefreshEvaluation, int]:
    """Scan one article. Returns (evaluation_row, llm_calls_used)."""
    now = datetime.now(timezone.utc)
    age_days = (now - (article.last_persisted_at or article.first_seen_at)).days

    log.info("refresh_scan_article.started", tick_id=str(tick_id), article_id=str(article.article_id),
             article_url=article.article_url)

    try:
        wp_post = await wp_client.fetch_post_by_url(article.article_url)
    except Exception as e:
        log.error("refresh_scan_article.failed", article_id=str(article.article_id), exc_info=True)
        ev = _insert_evaluation(
            session, article=article, trigger_source=trigger_source, age_days=age_days,
            deterministic_findings={"findings": [], "error": "wp_fetch_failed", "detail": str(e)[:500],
                                    "severity_high": 0, "severity_medium": 0, "severity_low": 0, "passed": False},
            llm_findings=None, llm_skipped_reason="scanner_error",
            score=0.0, action="ok",
        )
        article.next_scan_due_at = schedule_after_retry(now=now)
        article.updated_at = now
        return ev, 0

    if wp_post is None:
        ev = _insert_evaluation(
            session, article=article, trigger_source=trigger_source, age_days=age_days,
            deterministic_findings={"findings": [], "note": "wp_post_not_found",
                                    "severity_high": 0, "severity_medium": 0, "severity_low": 0, "passed": True},
            llm_findings=None, llm_skipped_reason="no_published_html",
            score=0.0, action="ok",
        )
        new_due = advance_schedule(action="ok", now=now)
        if new_due is not None:
            article.next_scan_due_at = new_due
        article.updated_at = now
        return ev, 0

    if article.wp_post_id is None:
        article.wp_post_id = wp_post.id

    html_hash = hashlib.sha256(wp_post.content_html.encode("utf-8")).hexdigest()
    det = await deterministic_audit_published_html(
        wp_post.content_html, modified_gmt=wp_post.modified_gmt,
        last_persisted_at=article.last_persisted_at,
    )

    llm_skipped_reason: str | None = None
    llm: LLMFindings | None = None
    llm_used = 0
    if det.passed:
        llm_skipped_reason = "deterministic_passed"
    elif llm_budget_remaining <= 0:
        llm_skipped_reason = "cap_exceeded"
    else:
        try:
            llm = await llm_audit_published(wp_post.content_html, persona=article.persona,
                                             gemini_client=gemini_client)
            llm_used = 1
        except Exception as e:
            log.error("refresh_scan_article.llm_failed", article_id=str(article.article_id), exc_info=True)
            llm_skipped_reason = "llm_error"

    score, action = compute_staleness(det, llm, age_days=age_days)

    ev = _insert_evaluation(
        session, article=article, trigger_source=trigger_source, age_days=age_days,
        fetched_html_hash=html_hash,
        deterministic_findings=det.to_jsonb(),
        llm_findings=(llm.raw if llm else None),
        llm_skipped_reason=llm_skipped_reason,
        score=float(score), action=action,
    )

    new_due = advance_schedule(action=action, now=now)
    if new_due is not None:
        article.next_scan_due_at = new_due
    article.updated_at = now

    log.info("refresh_scan_article.finished", tick_id=str(tick_id), article_id=str(article.article_id),
             det_passed=det.passed, llm_called=(llm is not None),
             recommended_action=action, staleness_score=float(score))
    return ev, llm_used


def _insert_evaluation(
    session: AsyncSession, *, article: Article, trigger_source: str, age_days: int,
    deterministic_findings: dict, llm_findings: dict | None, llm_skipped_reason: str | None,
    score: float, action: str, fetched_html_hash: str | None = None,
) -> RefreshEvaluation:
    # Mark previous open eval(s) as superseded — atomic with insert in caller's tx
    session.sync_session.execute(
        update(RefreshEvaluation)
        .where(RefreshEvaluation.article_id == article.article_id, RefreshEvaluation.outcome == "open")
        .values(outcome="superseded")
    )
    ev = RefreshEvaluation(
        article_id=article.article_id,
        scanner_version=SCANNER_VERSION,
        trigger_source=trigger_source,
        age_days=age_days,
        fetched_html_hash=fetched_html_hash,
        deterministic_findings=deterministic_findings,
        llm_findings=llm_findings,
        llm_skipped_reason=llm_skipped_reason,
        staleness_score=score,
        recommended_action=action,
        outcome="open",
    )
    session.add(ev)
    return ev


async def select_due_articles(session: AsyncSession, *, batch_size: int) -> list[Article]:
    stmt = (
        select(Article)
        .where(Article.next_scan_due_at <= datetime.now(timezone.utc))
        .where((Article.dismissed_until.is_(None)) | (Article.dismissed_until < datetime.now(timezone.utc)))
        .where(
            ~select(Run.run_id)
            .where(Run.article_id == Article.article_id)
            .where(Run.status.in_(IN_FLIGHT_STATUSES))
            .exists()
        )
        .order_by(Article.next_scan_due_at.asc())
        .limit(batch_size)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


async def scan_tick(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    wp_client: WordPressClient,
    gemini_client,
    trigger_source: TriggerSource = "cron",
    forced_article_ids: list[UUID] | None = None,
    force_bypass_due: bool = False,
) -> TickResult:
    cfg = get_refresh_config()
    scan_cfg = cfg["scan"]
    tick_id = uuid4()
    started_at = datetime.now(timezone.utc)
    log.info("refresh_scan_tick.started", tick_id=str(tick_id), trigger_source=trigger_source)

    result = TickResult(tick_id=tick_id, started_at=started_at)

    async with session_factory() as session:
        async with _advisory_lock(session, scan_cfg["tick_lock_key"]) as got:
            if not got:
                log.warning("refresh_scan_tick.contended", tick_id=str(tick_id))
                result.finished_at = datetime.now(timezone.utc)
                result.skipped = [{"reason": "scan_in_progress"}]
                return result

            # Select articles
            if forced_article_ids:
                stmt = select(Article).where(Article.article_id.in_(forced_article_ids))
                if not force_bypass_due:
                    stmt = stmt.where(Article.next_scan_due_at <= datetime.now(timezone.utc))
                articles = list((await session.execute(stmt)).scalars().all())
            else:
                articles = await select_due_articles(session, batch_size=scan_cfg["batch_size"])

            llm_budget = scan_cfg["llm_cap_per_tick"]

            for article in articles:
                try:
                    async with session.begin_nested():
                        ev, used = await scan_article(
                            session, article=article, wp_client=wp_client,
                            gemini_client=gemini_client, trigger_source=trigger_source,
                            llm_budget_remaining=llm_budget, tick_id=tick_id,
                        )
                        llm_budget -= used
                        result.scanned += 1
                        result.evaluations_created += 1
                        result.llm_calls += used
                except Exception:
                    log.error("refresh_scan_tick.article_aborted",
                              tick_id=str(tick_id), article_id=str(article.article_id), exc_info=True)
                    result.skipped.append({"article_id": str(article.article_id), "reason": "scan_exception"})

            await session.commit()

    result.finished_at = datetime.now(timezone.utc)
    log.info("refresh_scan_tick.finished", tick_id=str(tick_id),
             scanned=result.scanned, evaluations_created=result.evaluations_created,
             llm_calls=result.llm_calls, duration_ms=int((result.finished_at - started_at).total_seconds() * 1000))
    return result
```

- [ ] **Step 2: Write the failing test (single article)**

Create `tests/integration/test_refresh_scan_article.py`:

```python
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import httpx
import pytest
import respx
from uuid import uuid4

from content_tool.db.models import Article, RefreshEvaluation
from content_tool.refresh.scanner import scan_article, SCANNER_VERSION
from content_tool.wordpress.client import WordPressClient

@pytest.mark.asyncio
@respx.mock
async def test_scan_article_ok_writes_evaluation_ok(pg_session_factory, fake_gemini):
    sf = pg_session_factory
    wp_client = WordPressClient(base_url="https://wp.test", username="u", app_password="p", timeout=5.0)

    # Seed article
    async with sf() as s:
        a = Article(
            article_url="https://bowtie.com.hk/x/",
            next_scan_due_at=datetime.now(timezone.utc) - timedelta(days=1),
            persona="family",
            last_persisted_at=datetime.now(timezone.utc) - timedelta(days=10),
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        aid = a.article_id

    # Mock WP fetch returning current ok html
    fixture = json.loads(Path("tests/fixtures/wp_responses/post_by_slug.json").read_text())
    fixture[0]["content"]["rendered"] = Path("tests/fixtures/html/article_ok.html").read_text()
    respx.get("https://wp.test/wp-json/wp/v2/posts").mock(return_value=httpx.Response(200, json=fixture))
    respx.head("https://bowtie.com.hk/about/").mock(return_value=httpx.Response(200))
    respx.head("https://www.ia.org.hk/").mock(return_value=httpx.Response(200))

    async with sf() as s:
        a = await s.get(Article, aid)
        ev, llm_used = await scan_article(
            s, article=a, wp_client=wp_client, gemini_client=fake_gemini,
            trigger_source="manual_per_article", llm_budget_remaining=20, tick_id=uuid4(),
        )
        await s.commit()
        await s.refresh(ev)
        assert ev.recommended_action == "ok"
        assert ev.llm_skipped_reason == "deterministic_passed"
        assert llm_used == 0
        assert ev.scanner_version == SCANNER_VERSION


@pytest.mark.asyncio
@respx.mock
async def test_scan_article_broken_links_invokes_llm(pg_session_factory, fake_gemini):
    sf = pg_session_factory
    wp_client = WordPressClient(base_url="https://wp.test", username="u", app_password="p", timeout=5.0)

    async with sf() as s:
        a = Article(
            article_url="https://bowtie.com.hk/y/",
            next_scan_due_at=datetime.now(timezone.utc) - timedelta(days=1),
            persona="family",
            last_persisted_at=datetime.now(timezone.utc) - timedelta(days=200),
        )
        s.add(a)
        await s.commit()
        aid = a.article_id

    fixture = json.loads(Path("tests/fixtures/wp_responses/post_by_slug.json").read_text())
    fixture[0]["content"]["rendered"] = Path("tests/fixtures/html/article_broken_links.html").read_text()
    respx.get("https://wp.test/wp-json/wp/v2/posts").mock(return_value=httpx.Response(200, json=fixture))
    for url in ["https://broken.example.invalid/page", "https://another-broken.invalid", "https://yet-another.invalid"]:
        respx.head(url).mock(return_value=httpx.Response(404))
        respx.get(url).mock(return_value=httpx.Response(404))

    # Configure fake gemini to return a passing audit (no high/medium findings)
    fake_gemini.set_audit_response({"findings": [], "overall_pass": True})

    async with sf() as s:
        a = await s.get(Article, aid)
        ev, llm_used = await scan_article(
            s, article=a, wp_client=wp_client, gemini_client=fake_gemini,
            trigger_source="cron", llm_budget_remaining=20, tick_id=uuid4(),
        )
        await s.commit()
        assert ev.llm_findings is not None
        assert llm_used == 1
        # 3 broken links (severity medium) → det failed → LLM ran → no high severity → score from age+det
        assert ev.recommended_action in ("monitor", "refresh")
```

**Note for engineer:** the `fake_gemini` fixture exists in conftest from prior plans. If it doesn't expose `set_audit_response`, add a helper method to the existing fake — it should accept the canned dict that will be returned by `generate_json` when called with `response_schema_name="audit"`.

- [ ] **Step 3: Run the article-level test**

```
uv run pytest tests/integration/test_refresh_scan_article.py -v
```

Expected: both PASS. (You may need to adjust `fake_gemini` per the note above.)

- [ ] **Step 4: Write the failing test (tick)**

Create `tests/integration/test_refresh_scan_tick.py`:

```python
from datetime import datetime, timedelta, timezone
import pytest

from content_tool.db.models import Article, RefreshEvaluation, Run
from content_tool.refresh.scanner import scan_tick

@pytest.mark.asyncio
async def test_scan_tick_skips_in_progress_articles(pg_session_factory, wp_client_mocked_ok, fake_gemini):
    sf = pg_session_factory
    async with sf() as s:
        a1 = Article(article_url="https://bowtie/a1/", next_scan_due_at=datetime.now(timezone.utc) - timedelta(days=1))
        a2 = Article(article_url="https://bowtie/a2/", next_scan_due_at=datetime.now(timezone.utc) - timedelta(days=1))
        s.add_all([a1, a2])
        await s.commit()
        await s.refresh(a2)
        # a2 has an in-progress run
        s.add(Run(
            created_by="e", status="strategy",
            article_url=a2.article_url, topic="x", keywords=[], mode="small_refresh",
            acf_adv_id=0, acf_widget_id=0, persona="x",
            today_date=datetime.now(timezone.utc).date(),
            article_id=a2.article_id,
        ))
        await s.commit()

    result = await scan_tick(sf, wp_client=wp_client_mocked_ok, gemini_client=fake_gemini)
    assert result.scanned == 1
    assert result.evaluations_created == 1

@pytest.mark.asyncio
async def test_scan_tick_supersedes_previous_open(pg_session_factory, wp_client_mocked_ok, fake_gemini):
    sf = pg_session_factory
    async with sf() as s:
        a = Article(article_url="https://bowtie/a/", next_scan_due_at=datetime.now(timezone.utc) - timedelta(days=1))
        s.add(a)
        await s.commit()
        # First scan
        await scan_tick(sf, wp_client=wp_client_mocked_ok, gemini_client=fake_gemini)
        # Bump due to force re-scan
        async with sf() as s2:
            a2 = await s2.get(Article, a.article_id)
            a2.next_scan_due_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            await s2.commit()
        await scan_tick(sf, wp_client=wp_client_mocked_ok, gemini_client=fake_gemini)

    async with sf() as s3:
        evs = (await s3.execute(
            "SELECT outcome FROM content_tool.refresh_evaluations ORDER BY evaluated_at ASC"
        )).all()
        statuses = [r[0] for r in evs]
        assert statuses[0] == "superseded"
        assert statuses[-1] == "open"
```

**Conftest additions required:**

In `tests/conftest.py`, add `wp_client_mocked_ok` fixture (uses respx to return the article_ok.html for any post fetch):

```python
@pytest.fixture
def wp_client_mocked_ok():
    import respx, httpx, json
    from pathlib import Path
    from content_tool.wordpress.client import WordPressClient
    fixture = json.loads(Path("tests/fixtures/wp_responses/post_by_slug.json").read_text())
    fixture[0]["content"]["rendered"] = Path("tests/fixtures/html/article_ok.html").read_text()
    with respx.mock:
        respx.get(url__regex=r"https://wp\.test/wp-json/wp/v2/posts.*").mock(
            return_value=httpx.Response(200, json=fixture)
        )
        respx.head(url__regex=r"https?://.*").mock(return_value=httpx.Response(200))
        yield WordPressClient(base_url="https://wp.test", username="u", app_password="p", timeout=5.0)
```

- [ ] **Step 5: Run the tick test**

```
uv run pytest tests/integration/test_refresh_scan_tick.py -v
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add content_tool/refresh/scanner.py tests/integration/test_refresh_scan_article.py tests/integration/test_refresh_scan_tick.py tests/conftest.py
git commit -m "feat(refresh): scanner — scan_article, scan_tick, advisory lock, supersede-on-insert"
```

---

### Task 10: CLI entrypoint `scripts/refresh_scan.py`

**Files:**
- Create: `scripts/__init__.py` (empty)
- Create: `scripts/refresh_scan.py`

- [ ] **Step 1: Create empty `scripts/__init__.py`**

```python
```

- [ ] **Step 2: Create `scripts/refresh_scan.py`**

```python
#!/usr/bin/env python
"""CLI entrypoint: run a refresh scan tick.

Invocation:
    uv run python -m scripts.refresh_scan
Or via cron, with env vars set in the cron environment.

Exits 0 on success (including when nothing was due to scan), non-zero only on
unrecoverable errors. Per-article errors are logged and result in evaluation
rows with the error captured; they do NOT fail the tick.
"""
from __future__ import annotations

import asyncio
import os
import sys

import click

from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.client import RealGeminiClient
from content_tool.observability.logging import configure_logging
from content_tool.observability.tracing import configure_tracing
from content_tool.refresh.scanner import scan_tick
from content_tool.wordpress.client import WordPressClient


@click.command()
@click.option("--article-id", "article_ids", multiple=True, help="Limit to these articles (repeatable).")
@click.option("--force", is_flag=True, help="Bypass next_scan_due_at gate (still honors dismissed_until + in-progress).")
@click.option("--dry-run", is_flag=True, help="Print what would be scanned; no DB writes.")
def main(article_ids: tuple[str, ...], force: bool, dry_run: bool) -> None:
    """Run a single refresh tick."""
    if os.getenv("REFRESH_CRON_ENABLED", "true").lower() != "true":
        click.echo("REFRESH_CRON_ENABLED=false; exiting 0 without scanning.")
        sys.exit(0)

    configure_logging(os.getenv("LOG_LEVEL", "info"))
    configure_tracing()

    asyncio.run(_run(article_ids=article_ids, force=force, dry_run=dry_run))


async def _run(*, article_ids: tuple[str, ...], force: bool, dry_run: bool) -> None:
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    try:
        wp_client = WordPressClient(
            settings.wp_base_url,
            username=settings.wp_username,
            app_password=settings.wp_app_password,
            timeout=settings.wp_timeout,
        )
        gemini = RealGeminiClient(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            thinking_level=settings.gemini_thinking_level,
        )
        from uuid import UUID
        forced = [UUID(s) for s in article_ids] if article_ids else None

        if dry_run:
            from sqlalchemy import select
            from content_tool.db.models import Article
            from content_tool.refresh.scanner import select_due_articles
            async with sf() as s:
                if forced:
                    rows = (await s.execute(select(Article).where(Article.article_id.in_(forced)))).scalars().all()
                else:
                    rows = await select_due_articles(s, batch_size=200)
                click.echo(f"Would scan {len(rows)} article(s):")
                for r in rows:
                    click.echo(f"  - {r.article_id} {r.article_url}")
            return

        result = await scan_tick(
            sf, wp_client=wp_client, gemini_client=gemini,
            trigger_source="cron",
            forced_article_ids=forced, force_bypass_due=force,
        )
        click.echo(
            f"tick {result.tick_id}: scanned={result.scanned} "
            f"evals={result.evaluations_created} llm={result.llm_calls} "
            f"skipped={len(result.skipped or [])}"
        )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Smoke-test dry-run**

(Assumes you have a local Postgres running and migrations applied.)

```
uv run python -m scripts.refresh_scan --dry-run
```

Expected: prints `Would scan N article(s):` listing.

- [ ] **Step 4: Commit**

```bash
git add scripts/__init__.py scripts/refresh_scan.py
git commit -m "feat(refresh): CLI entrypoint scripts/refresh_scan.py"
```

---

### Task 11: API routes — `/articles`

**Files:**
- Create: `content_tool/api/routes/articles.py`
- Modify: `content_tool/api/main.py` (include router)
- Test: `tests/integration/test_refresh_api_articles.py`

- [ ] **Step 1: Create `content_tool/api/routes/articles.py`**

```python
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.api.schemas import (
    ArticleDetailOut, ArticleListResponse, ArticleOut,
    DismissRequest, RefreshEvaluationOut,
)
from content_tool.db.models import Article, RefreshEvaluation, Run

router = APIRouter(prefix="/articles", tags=["articles"])


async def _session(request: Request) -> AsyncSession:
    sf: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    async with sf() as s:
        yield s


def _to_out(a: Article, latest_eval: RefreshEvaluation | None, open_runs_count: int) -> ArticleOut:
    return ArticleOut(
        article_id=a.article_id, article_url=a.article_url, wp_post_id=a.wp_post_id,
        topic=a.topic, persona=a.persona, topic_category=a.topic_category,
        first_seen_at=a.first_seen_at, last_persisted_at=a.last_persisted_at,
        next_scan_due_at=a.next_scan_due_at, dismissed_until=a.dismissed_until,
        latest_evaluation=(
            RefreshEvaluationOut.model_validate(latest_eval, from_attributes=True)
            if latest_eval else None
        ),
        open_runs_count=open_runs_count,
    )


@router.get("", response_model=ArticleListResponse)
async def list_articles(
    needs_refresh: bool | None = Query(None),
    persona: str | None = Query(None),
    topic_category: str | None = Query(None),
    q: str | None = Query(None),
    sort: Literal["staleness", "next_scan_due", "last_persisted"] = Query("staleness"),
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(_session),
) -> ArticleListResponse:
    latest_eval_sq = (
        select(
            RefreshEvaluation.article_id,
            RefreshEvaluation.evaluation_id.label("latest_eval_id"),
            func.row_number()
            .over(partition_by=RefreshEvaluation.article_id,
                  order_by=RefreshEvaluation.evaluated_at.desc())
            .label("rn"),
        ).subquery()
    )
    latest_only = (
        select(latest_eval_sq.c.article_id, latest_eval_sq.c.latest_eval_id)
        .where(latest_eval_sq.c.rn == 1).subquery()
    )

    base = (
        select(Article, RefreshEvaluation)
        .join(latest_only, latest_only.c.article_id == Article.article_id, isouter=True)
        .join(RefreshEvaluation, RefreshEvaluation.evaluation_id == latest_only.c.latest_eval_id, isouter=True)
    )

    if needs_refresh:
        base = base.where(RefreshEvaluation.recommended_action == "refresh", RefreshEvaluation.outcome == "open")
    if persona:
        base = base.where(Article.persona == persona)
    if topic_category:
        base = base.where(Article.topic_category == topic_category)
    if q:
        like = f"%{q}%"
        base = base.where(or_(Article.topic.ilike(like), Article.article_url.ilike(like)))

    if sort == "staleness":
        base = base.order_by(RefreshEvaluation.staleness_score.desc().nullslast())
    elif sort == "next_scan_due":
        base = base.order_by(Article.next_scan_due_at.asc())
    else:
        base = base.order_by(Article.last_persisted_at.desc().nullslast())

    total_q = select(func.count()).select_from(base.subquery())
    total = (await session.execute(total_q)).scalar_one()

    rows = (await session.execute(base.limit(limit).offset(offset))).all()
    items: list[ArticleOut] = []
    for a, ev in rows:
        # Count in-progress runs per article
        ip = (await session.execute(
            select(func.count()).select_from(Run)
            .where(Run.article_id == a.article_id)
            .where(Run.status.in_(("pending", "strategy", "hitl_1", "production", "hitl_2", "persisted")))
        )).scalar_one()
        items.append(_to_out(a, ev, open_runs_count=int(ip)))

    return ArticleListResponse(items=items, total=int(total))


@router.get("/{article_id}", response_model=ArticleDetailOut)
async def get_article(article_id: UUID, session: AsyncSession = Depends(_session)) -> ArticleDetailOut:
    a = await session.get(Article, article_id)
    if a is None:
        raise HTTPException(status_code=404, detail="article not found")
    evs = (await session.execute(
        select(RefreshEvaluation).where(RefreshEvaluation.article_id == article_id)
        .order_by(RefreshEvaluation.evaluated_at.desc()).limit(10)
    )).scalars().all()
    run_ids = (await session.execute(
        select(Run.run_id).where(Run.article_id == article_id)
        .order_by(Run.created_at.desc()).limit(10)
    )).scalars().all()
    ip = (await session.execute(
        select(func.count()).select_from(Run).where(Run.article_id == article_id)
        .where(Run.status.in_(("pending", "strategy", "hitl_1", "production", "hitl_2", "persisted")))
    )).scalar_one()
    latest = evs[0] if evs else None
    base = _to_out(a, latest, open_runs_count=int(ip))
    return ArticleDetailOut(
        **base.model_dump(),
        recent_evaluations=[RefreshEvaluationOut.model_validate(e, from_attributes=True) for e in evs],
        recent_run_ids=list(run_ids),
    )


@router.post("/{article_id}/dismiss", response_model=ArticleOut)
async def dismiss_article(
    article_id: UUID, body: DismissRequest, session: AsyncSession = Depends(_session)
) -> ArticleOut:
    if body.until <= datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="until must be in the future")
    a = await session.get(Article, article_id)
    if a is None:
        raise HTTPException(status_code=404, detail="article not found")
    a.dismissed_until = body.until
    a.dismissed_by = body.dismissed_by
    a.dismissed_reason = body.reason
    a.next_scan_due_at = body.until                       # per spec §5.1 — due the instant dismissal expires
    a.updated_at = datetime.now(timezone.utc)

    # Flip latest open eval to dismissed
    latest_open = (await session.execute(
        select(RefreshEvaluation)
        .where(RefreshEvaluation.article_id == article_id, RefreshEvaluation.outcome == "open")
        .order_by(RefreshEvaluation.evaluated_at.desc()).limit(1)
    )).scalar_one_or_none()
    if latest_open is not None:
        latest_open.outcome = "dismissed"
        latest_open.outcome_set_at = datetime.now(timezone.utc)
        latest_open.outcome_set_by = body.dismissed_by

    await session.commit()
    await session.refresh(a)
    return _to_out(a, latest_open, open_runs_count=0)


@router.delete("/{article_id}/dismiss", response_model=ArticleOut)
async def clear_dismissal(
    article_id: UUID, session: AsyncSession = Depends(_session)
) -> ArticleOut:
    a = await session.get(Article, article_id)
    if a is None:
        raise HTTPException(status_code=404, detail="article not found")
    a.dismissed_until = None
    a.dismissed_by = None
    a.dismissed_reason = None
    a.updated_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(a)
    return _to_out(a, None, open_runs_count=0)
```

- [ ] **Step 2: Register router in `content_tool/api/main.py`**

Add import and `app.include_router(articles_router)` next to the existing includes:

```python
from content_tool.api.routes.articles import router as articles_router
# ... and inside create_app() after the existing include_router calls:
app.include_router(articles_router)
```

- [ ] **Step 3: Write the failing test**

Create `tests/integration/test_refresh_api_articles.py`:

```python
from datetime import datetime, timedelta, timezone
import pytest
from httpx import AsyncClient
from content_tool.db.models import Article, RefreshEvaluation

@pytest.mark.asyncio
async def test_list_articles_default_filter_needs_refresh(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a1 = Article(article_url="https://b/a1", next_scan_due_at=datetime.now(timezone.utc))
        a2 = Article(article_url="https://b/a2", next_scan_due_at=datetime.now(timezone.utc))
        s.add_all([a1, a2])
        await s.commit()
        s.add(RefreshEvaluation(
            article_id=a1.article_id, scanner_version="t", trigger_source="cron",
            age_days=120, deterministic_findings={}, staleness_score="7.50",
            recommended_action="refresh", outcome="open",
        ))
        s.add(RefreshEvaluation(
            article_id=a2.article_id, scanner_version="t", trigger_source="cron",
            age_days=10, deterministic_findings={}, staleness_score="0.50",
            recommended_action="ok", outcome="open",
        ))
        await s.commit()

    resp = await api_client.get("/articles?needs_refresh=true")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["article_url"] == "https://b/a1"


@pytest.mark.asyncio
async def test_dismiss_sets_until_and_flips_open_eval(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a = Article(article_url="https://b/a", next_scan_due_at=datetime.now(timezone.utc))
        s.add(a)
        await s.commit()
        ev = RefreshEvaluation(
            article_id=a.article_id, scanner_version="t", trigger_source="cron",
            age_days=120, deterministic_findings={}, staleness_score="7.50",
            recommended_action="refresh", outcome="open",
        )
        s.add(ev); await s.commit()
        aid = a.article_id

    until = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    resp = await api_client.post(
        f"/articles/{aid}/dismiss",
        json={"until": until, "reason": "wait for v2 product launch", "dismissed_by": "editor@bowtie"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dismissed_until"] is not None

    async with sf() as s:
        ev2 = (await s.execute("SELECT outcome FROM content_tool.refresh_evaluations LIMIT 1")).scalar_one()
        assert ev2 == "dismissed"


@pytest.mark.asyncio
async def test_dismiss_until_in_past_returns_422(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a = Article(article_url="https://b/a", next_scan_due_at=datetime.now(timezone.utc))
        s.add(a); await s.commit()
        aid = a.article_id

    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    resp = await api_client.post(
        f"/articles/{aid}/dismiss",
        json={"until": past, "dismissed_by": "editor@bowtie"},
    )
    assert resp.status_code == 422
```

- [ ] **Step 4: Run tests**

```
uv run pytest tests/integration/test_refresh_api_articles.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add content_tool/api/routes/articles.py content_tool/api/main.py tests/integration/test_refresh_api_articles.py
git commit -m "feat(api): /articles list, detail, dismiss endpoints"
```

---

### Task 12: API routes — `/refresh`

**Files:**
- Create: `content_tool/api/routes/refresh.py`
- Modify: `content_tool/api/main.py` (include router)
- Test: `tests/integration/test_refresh_api_scan.py`

- [ ] **Step 1: Create `content_tool/api/routes/refresh.py`**

```python
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.api.schemas import (
    RefreshEvaluationOut, ScanRequest, ScanResponse,
)
from content_tool.db.models import Article, RefreshEvaluation, Run
from content_tool.refresh.scanner import scan_tick, scan_article, IN_FLIGHT_STATUSES
from uuid import uuid4

router = APIRouter(prefix="/refresh", tags=["refresh"])


async def _session(request: Request) -> AsyncSession:
    sf: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    async with sf() as s:
        yield s


@router.post("/scan", response_model=ScanResponse)
async def trigger_scan(
    request: Request,
    body: ScanRequest = Body(default_factory=ScanRequest),
) -> ScanResponse:
    sf: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    wp_client = request.app.state.wp_client
    gemini = request.app.state.run_executor._gemini  # reuse the executor's client

    result = await scan_tick(
        sf, wp_client=wp_client, gemini_client=gemini,
        trigger_source="manual_api",
        forced_article_ids=body.article_ids,
        force_bypass_due=body.force,
    )

    if result.skipped and any(s.get("reason") == "scan_in_progress" for s in result.skipped):
        raise HTTPException(status_code=409, detail="scan_in_progress")

    return ScanResponse(
        tick_id=result.tick_id,
        scanned=result.scanned,
        evaluations_created=result.evaluations_created,
        llm_calls=result.llm_calls,
        est_cost_usd_cents=result.est_cost_usd_cents,
        started_at=result.started_at,
        finished_at=result.finished_at,
        skipped=result.skipped or [],
    )


@router.post("/scan/{article_id}", response_model=RefreshEvaluationOut)
async def trigger_scan_one(
    article_id: UUID, request: Request, force: bool = False,
    session: AsyncSession = Depends(_session),
) -> RefreshEvaluationOut:
    a = await session.get(Article, article_id)
    if a is None:
        raise HTTPException(status_code=404, detail="article not found")

    if a.dismissed_until and not force:
        raise HTTPException(status_code=410, detail="article dismissed; pass ?force=true to override")

    inflight = (await session.execute(
        select(Run.run_id).where(Run.article_id == article_id).where(Run.status.in_(IN_FLIGHT_STATUSES))
    )).scalar_one_or_none()
    if inflight is not None:
        raise HTTPException(status_code=409, detail={"reason": "in_progress_run", "run_id": str(inflight)})

    wp_client = request.app.state.wp_client
    gemini = request.app.state.run_executor._gemini

    ev, _ = await scan_article(
        session, article=a, wp_client=wp_client, gemini_client=gemini,
        trigger_source="manual_per_article",
        llm_budget_remaining=999,    # per-article scan bypasses tick budget
        tick_id=uuid4(),
    )
    await session.commit()
    await session.refresh(ev)
    return RefreshEvaluationOut.model_validate(ev, from_attributes=True)


@router.get("/evaluations/{evaluation_id}", response_model=RefreshEvaluationOut)
async def get_evaluation(
    evaluation_id: UUID, session: AsyncSession = Depends(_session)
) -> RefreshEvaluationOut:
    ev = await session.get(RefreshEvaluation, evaluation_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="evaluation not found")
    return RefreshEvaluationOut.model_validate(ev, from_attributes=True)
```

**Note for engineer:** the line `request.app.state.run_executor._gemini` reaches into the RunExecutor for its Gemini client. If the executor doesn't expose its client (private attr lookup), instead store `gemini` on `app.state` at startup in `main.py` next to `wp_client`. Pick whichever is cleaner once you read the existing `main.py` lifespan.

- [ ] **Step 2: Register router in `content_tool/api/main.py`**

```python
from content_tool.api.routes.refresh import router as refresh_router
# inside create_app():
app.include_router(refresh_router)
```

If you opted to expose Gemini on `app.state`, also do this in the lifespan:

```python
app.state.gemini_client = gemini
```

And update `refresh.py` to read `request.app.state.gemini_client` instead.

- [ ] **Step 3: Write the failing test**

Create `tests/integration/test_refresh_api_scan.py`:

```python
from datetime import datetime, timedelta, timezone
import pytest
from httpx import AsyncClient
from content_tool.db.models import Article, Run

@pytest.mark.asyncio
async def test_post_refresh_scan_returns_tick_summary(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a = Article(
            article_url="https://wp.test/x/",
            next_scan_due_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        s.add(a); await s.commit()

    resp = await api_client.post("/refresh/scan", json={})
    assert resp.status_code == 200
    data = resp.json()
    assert "tick_id" in data
    assert data["scanned"] == 1
    assert data["evaluations_created"] == 1


@pytest.mark.asyncio
async def test_post_refresh_scan_id_409_when_inflight_run(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a = Article(article_url="https://wp.test/y/", next_scan_due_at=datetime.now(timezone.utc))
        s.add(a); await s.commit(); aid = a.article_id
        s.add(Run(
            created_by="e", status="strategy", article_url=a.article_url,
            topic="x", keywords=[], mode="small_refresh",
            acf_adv_id=0, acf_widget_id=0, persona="x",
            today_date=datetime.now(timezone.utc).date(), article_id=a.article_id,
        ))
        await s.commit()

    resp = await api_client.post(f"/refresh/scan/{aid}")
    assert resp.status_code == 409
    assert resp.json()["detail"]["reason"] == "in_progress_run"
```

- [ ] **Step 4: Run tests**

```
uv run pytest tests/integration/test_refresh_api_scan.py -v
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add content_tool/api/routes/refresh.py content_tool/api/main.py tests/integration/test_refresh_api_scan.py
git commit -m "feat(api): /refresh/scan + /refresh/scan/{id} + /refresh/evaluations/{id}"
```

---

### Task 13: Patch `POST /runs` — upsert Article + accept `triggered_by_evaluation_id`

**Files:**
- Modify: `content_tool/api/routes/runs.py`
- Modify: `content_tool/api/schemas.py` (Run request/response schemas — add fields)
- Test: `tests/integration/test_refresh_click_through.py`

- [ ] **Step 1: Add `triggered_by_evaluation_id` to the Run trigger request schema**

In `content_tool/api/schemas.py`, locate the existing trigger-request model (whatever `POST /runs` accepts — likely `RunCreate` or similar) and add:

```python
class RunCreate(BaseModel):
    # ... existing fields ...
    triggered_by_evaluation_id: UUID | None = None
```

Also add to the Run response model:

```python
class RunOut(BaseModel):
    # ... existing fields ...
    article_id: UUID | None = None
    triggered_by_evaluation: RefreshEvaluationOut | None = None
```

- [ ] **Step 2: Patch the `POST /runs` handler in `content_tool/api/routes/runs.py`**

Inside the handler, after parsing the request and before inserting the Run:

```python
from content_tool.refresh.inventory import upsert_article
from content_tool.db.models import RefreshEvaluation
from datetime import datetime, timezone

article = await upsert_article(
    session,
    article_url=body.article_url,
    topic=body.topic, persona=body.persona, topic_category=body.topic_category,
)
# Validate evaluation if provided
ev = None
if body.triggered_by_evaluation_id is not None:
    ev = await session.get(RefreshEvaluation, body.triggered_by_evaluation_id)
    if ev is None or ev.article_id != article.article_id:
        raise HTTPException(status_code=422, detail="triggered_by_evaluation_id mismatch")
    if ev.outcome != "open":
        raise HTTPException(status_code=409, detail="evaluation already resolved")

# Insert Run with article_id and triggered_by_evaluation_id
new_run = Run(
    # ... existing fields ...
    article_id=article.article_id,
    triggered_by_evaluation_id=ev.evaluation_id if ev else None,
)
session.add(new_run)
await session.flush()

# Flip evaluation outcome if linked
if ev is not None:
    ev.outcome = "triggered"
    ev.resulting_run_id = new_run.run_id
    ev.outcome_set_at = datetime.now(timezone.utc)
    ev.outcome_set_by = body.created_by
```

Also, in the `GET /runs/{id}` handler, join the linked evaluation and include in `RunOut.triggered_by_evaluation`. Pseudocode:

```python
run = await session.get(Run, run_id)
ev = None
if run.triggered_by_evaluation_id:
    ev = await session.get(RefreshEvaluation, run.triggered_by_evaluation_id)
out = RunOut.model_validate(run, from_attributes=True)
out.triggered_by_evaluation = RefreshEvaluationOut.model_validate(ev, from_attributes=True) if ev else None
return out
```

- [ ] **Step 3: Write the failing test**

Create `tests/integration/test_refresh_click_through.py`:

```python
from datetime import datetime, timezone
import pytest
from httpx import AsyncClient
from content_tool.db.models import Article, RefreshEvaluation

@pytest.mark.asyncio
async def test_post_runs_with_evaluation_id_flips_outcome(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a = Article(article_url="https://b/ct", next_scan_due_at=datetime.now(timezone.utc))
        s.add(a); await s.commit()
        ev = RefreshEvaluation(
            article_id=a.article_id, scanner_version="t", trigger_source="cron",
            age_days=120, deterministic_findings={}, staleness_score="7.50",
            recommended_action="refresh", outcome="open",
        )
        s.add(ev); await s.commit()
        eid = ev.evaluation_id

    resp = await api_client.post(
        "/runs",
        json={
            "article_url": "https://b/ct",
            "topic": "X", "keywords": [], "mode": "small_refresh",
            "acf_adv_id": 0, "acf_widget_id": 0, "persona": "family",
            "today_date": str(datetime.now(timezone.utc).date()),
            "created_by": "editor@bowtie",
            "triggered_by_evaluation_id": str(eid),
        },
    )
    assert resp.status_code in (200, 201)
    run_id = resp.json()["run_id"]

    async with sf() as s:
        ev2 = await s.get(RefreshEvaluation, eid)
        assert ev2.outcome == "triggered"
        assert str(ev2.resulting_run_id) == run_id


@pytest.mark.asyncio
async def test_post_runs_evaluation_mismatch_returns_422(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a1 = Article(article_url="https://b/a", next_scan_due_at=datetime.now(timezone.utc))
        a2 = Article(article_url="https://b/b", next_scan_due_at=datetime.now(timezone.utc))
        s.add_all([a1, a2]); await s.commit()
        ev = RefreshEvaluation(
            article_id=a1.article_id, scanner_version="t", trigger_source="cron",
            age_days=120, deterministic_findings={}, staleness_score="7.50",
            recommended_action="refresh", outcome="open",
        )
        s.add(ev); await s.commit(); eid = ev.evaluation_id

    resp = await api_client.post(
        "/runs",
        json={
            "article_url": "https://b/b",  # different article
            "topic": "X", "keywords": [], "mode": "small_refresh",
            "acf_adv_id": 0, "acf_widget_id": 0, "persona": "family",
            "today_date": str(datetime.now(timezone.utc).date()),
            "created_by": "editor@bowtie",
            "triggered_by_evaluation_id": str(eid),
        },
    )
    assert resp.status_code == 422
```

- [ ] **Step 4: Run the test + existing runs tests**

```
uv run pytest tests/integration/test_refresh_click_through.py tests/integration/test_api_runs.py -v
```

Expected: all PASS (no regression in existing runs tests).

- [ ] **Step 5: Commit**

```bash
git add content_tool/api/routes/runs.py content_tool/api/schemas.py tests/integration/test_refresh_click_through.py
git commit -m "feat(api): POST /runs accepts triggered_by_evaluation_id; upserts Article"
```

---

### Task 14: Cost meter — `kind="refresh_scan"`

**Files:**
- Modify: `content_tool/api/routes/costs.py`
- Modify: `content_tool/refresh/scanner.py` (write tokens/cost to evaluation row — already wired in Task 9, verify)
- Test: `tests/unit/test_cost.py` (extend existing) — new case

- [ ] **Step 1: Extend the existing cost endpoint to surface `refresh_scan` totals**

Open `content_tool/api/routes/costs.py`. Find the aggregation query that sums tokens/costs from Run-side audit_runs and drafts; extend it to also sum from `refresh_evaluations` keyed by `kind="refresh_scan"`. Expected response shape gains a `refresh_scan_30d` block.

Concrete pattern (adapt to the file's existing style):

```python
@router.get("/summary")
async def cost_summary(session: AsyncSession = Depends(_session)) -> dict:
    # existing run-based totals ...
    refresh = (await session.execute(text("""
        SELECT
          COALESCE(SUM(tokens_in), 0) AS tokens_in,
          COALESCE(SUM(tokens_out), 0) AS tokens_out,
          COALESCE(SUM(est_cost_usd_cents), 0) AS cents
        FROM content_tool.refresh_evaluations
        WHERE evaluated_at >= now() - INTERVAL '30 days'
    """))).one()
    return {
        # ... existing keys ...
        "refresh_scan_30d": {
            "tokens_in": int(refresh.tokens_in),
            "tokens_out": int(refresh.tokens_out),
            "cents": int(refresh.cents),
        },
    }
```

- [ ] **Step 2: Verify scanner writes tokens/cost into evaluation rows**

In `content_tool/refresh/scanner.py`, when the LLM call succeeds, capture `tokens_in`, `tokens_out`, and `est_cost_usd_cents` from the existing Gemini client's usage stats and pass them to `_insert_evaluation`. Add these parameters to `_insert_evaluation`:

```python
def _insert_evaluation(
    session, *, article, trigger_source, age_days,
    deterministic_findings, llm_findings, llm_skipped_reason,
    score, action, fetched_html_hash=None,
    tokens_in=None, tokens_out=None, est_cost_usd_cents=None, latency_ms=None,
) -> RefreshEvaluation:
    # ... existing body ...
    ev = RefreshEvaluation(
        # ... existing fields ...
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        est_cost_usd_cents=est_cost_usd_cents,
        latency_ms=latency_ms,
    )
    # ...
```

In `scan_article`, after the LLM call succeeds, extract usage from the existing Gemini client (look at how the audit node records usage; reuse that adapter — likely `content_tool/observability/cost.py` has a `calculate_cost_cents(tokens_in, tokens_out, model)` helper) and pass into `_insert_evaluation`.

- [ ] **Step 3: Write the failing test**

Add a case in `tests/unit/test_cost.py`:

```python
def test_cost_calculator_handles_refresh_scan_kind():
    from content_tool.observability.cost import calculate_cost_cents
    cents = calculate_cost_cents(tokens_in=1000, tokens_out=500, model="gemini-flash")
    assert cents > 0
```

(If the existing helper already passes this case, the addition is a regression guard. If the helper takes a `kind` parameter, pass `kind="refresh_scan"`.)

- [ ] **Step 4: Run the test**

```
uv run pytest tests/unit/test_cost.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add content_tool/api/routes/costs.py content_tool/refresh/scanner.py tests/unit/test_cost.py
git commit -m "feat(ops): refresh_scan tokens + cost in evaluations and cost summary"
```

---

### Task 15: Cron template + ops note

**Files:**
- Create: `deploy/cron/refresh.cron`

- [ ] **Step 1: Create `deploy/cron/refresh.cron`**

```
# Bowtie AI Content Tool — Refresh route cron
#
# This is a TEMPLATE for system cron / k8s CronJob / GitHub Actions cron.
# The actual operationalisation host is an ops decision (see spec §10 open
# question 1). Match the existing nightly-reference-eval cron pattern.
#
# Schedule: 03:00 HKT (HKT = UTC+8, so cron line below assumes UTC)
# Adjust to your TZ if your scheduler is local-time.
#
# Required env vars (inherit from systemd EnvironmentFile or k8s ConfigMap):
#   POSTGRES_URL                — same as FastAPI app
#   GEMINI_API_KEY              — same as FastAPI app
#   WP_BASE_URL, WP_USERNAME, WP_APP_PASSWORD  — same as FastAPI app
#   REFRESH_CRON_ENABLED=true   — kill-switch
#
# Command:
#   uv run python -m scripts.refresh_scan
#
# Example crontab line (system cron, UTC):
# 0 19 * * *  REFRESH_CRON_ENABLED=true /opt/bowtie-content-tool/.venv/bin/python -m scripts.refresh_scan >> /var/log/bowtie/refresh.log 2>&1
#
# Example k8s CronJob skeleton:
# apiVersion: batch/v1
# kind: CronJob
# metadata:
#   name: refresh-scan
# spec:
#   schedule: "0 19 * * *"          # 03:00 HKT
#   jobTemplate:
#     spec:
#       template:
#         spec:
#           containers:
#             - name: scan
#               image: bowtie/content-tool:latest
#               command: ["python", "-m", "scripts.refresh_scan"]
#               envFrom:
#                 - secretRef: { name: content-tool-secrets }
#                 - configMapRef: { name: content-tool-config }
#           restartPolicy: OnFailure
```

- [ ] **Step 2: Commit**

```bash
git add deploy/cron/refresh.cron
git commit -m "docs(ops): refresh.cron template + ops note"
```

---

### Task 16: Web — types + API client

**Files:**
- Modify: `web/lib/types.ts`
- Modify: `web/lib/api.ts`

- [ ] **Step 1: Add TypeScript types**

Append to `web/lib/types.ts`:

```typescript
export type RecommendedAction = "refresh" | "monitor" | "ok";
export type EvaluationOutcome = "open" | "triggered" | "dismissed" | "superseded";

export interface RefreshEvaluation {
  evaluation_id: string;
  evaluated_at: string;
  age_days: number;
  staleness_score: string;          // Decimal as string from JSON
  recommended_action: RecommendedAction;
  deterministic_findings: {
    findings: Array<{ id: string; severity: "high" | "medium" | "low"; message: string; context?: Record<string, unknown> }>;
    severity_high: number;
    severity_medium: number;
    severity_low: number;
    passed: boolean;
  };
  llm_findings: Record<string, unknown> | null;
  llm_skipped_reason: string | null;
  outcome: EvaluationOutcome;
  resulting_run_id: string | null;
}

export interface Article {
  article_id: string;
  article_url: string;
  wp_post_id: number | null;
  topic: string | null;
  persona: string | null;
  topic_category: string | null;
  first_seen_at: string;
  last_persisted_at: string | null;
  next_scan_due_at: string;
  dismissed_until: string | null;
  latest_evaluation: RefreshEvaluation | null;
  open_runs_count: number;
}

export interface ArticleListResponse {
  items: Article[];
  total: number;
}

export interface ArticleDetail extends Article {
  recent_evaluations: RefreshEvaluation[];
  recent_run_ids: string[];
}

export interface ScanResponse {
  tick_id: string;
  scanned: number;
  evaluations_created: number;
  llm_calls: number;
  est_cost_usd_cents: number;
  started_at: string;
  finished_at: string;
  skipped: Array<{ article_id?: string; reason: string }>;
}
```

- [ ] **Step 2: Add API client methods**

Append to `web/lib/api.ts`:

```typescript
import type {
  Article, ArticleListResponse, ArticleDetail,
  RefreshEvaluation, ScanResponse,
} from "./types";

export const articlesApi = {
  list: async (params: {
    needs_refresh?: boolean; persona?: string; topic_category?: string;
    q?: string; sort?: "staleness" | "next_scan_due" | "last_persisted";
    limit?: number; offset?: number;
  }): Promise<ArticleListResponse> => {
    const qs = new URLSearchParams();
    if (params.needs_refresh !== undefined) qs.set("needs_refresh", String(params.needs_refresh));
    if (params.persona) qs.set("persona", params.persona);
    if (params.topic_category) qs.set("topic_category", params.topic_category);
    if (params.q) qs.set("q", params.q);
    if (params.sort) qs.set("sort", params.sort);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const r = await fetch(`${API_BASE}/articles?${qs.toString()}`);
    if (!r.ok) throw new Error(`articles.list ${r.status}`);
    return r.json();
  },

  detail: async (articleId: string): Promise<ArticleDetail> => {
    const r = await fetch(`${API_BASE}/articles/${articleId}`);
    if (!r.ok) throw new Error(`articles.detail ${r.status}`);
    return r.json();
  },

  dismiss: async (articleId: string, until: string, dismissedBy: string, reason?: string): Promise<Article> => {
    const r = await fetch(`${API_BASE}/articles/${articleId}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ until, dismissed_by: dismissedBy, reason }),
    });
    if (!r.ok) throw new Error(`articles.dismiss ${r.status}`);
    return r.json();
  },

  clearDismiss: async (articleId: string): Promise<Article> => {
    const r = await fetch(`${API_BASE}/articles/${articleId}/dismiss`, { method: "DELETE" });
    if (!r.ok) throw new Error(`articles.clearDismiss ${r.status}`);
    return r.json();
  },
};

export const refreshApi = {
  scanAll: async (): Promise<ScanResponse> => {
    const r = await fetch(`${API_BASE}/refresh/scan`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    if (!r.ok) throw new Error(`refresh.scanAll ${r.status}`);
    return r.json();
  },
  scanOne: async (articleId: string, force = false): Promise<RefreshEvaluation> => {
    const r = await fetch(`${API_BASE}/refresh/scan/${articleId}${force ? "?force=true" : ""}`, {
      method: "POST",
    });
    if (!r.ok) throw new Error(`refresh.scanOne ${r.status}`);
    return r.json();
  },
  getEvaluation: async (evaluationId: string): Promise<RefreshEvaluation> => {
    const r = await fetch(`${API_BASE}/refresh/evaluations/${evaluationId}`);
    if (!r.ok) throw new Error(`refresh.getEvaluation ${r.status}`);
    return r.json();
  },
};
```

(The existing `api.ts` exports `API_BASE` and the `api` object — match those export names; the engineer may need to merge the new methods into the existing `api` object instead of new exports.)

- [ ] **Step 3: TypeScript compile check**

```
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/lib/types.ts web/lib/api.ts
git commit -m "feat(web): types + api client for articles and refresh"
```

---

### Task 17: Web — add shadcn `calendar` and `sheet`; build core components

**Files:**
- Add via shadcn CLI: `web/components/ui/calendar.tsx`, `web/components/ui/sheet.tsx`
- Create: `web/components/StalenessIndicator.tsx`, `web/components/RefreshFindingsPanel.tsx`, `web/components/DismissDialog.tsx`, `web/components/ArticleDetailDrawer.tsx`

- [ ] **Step 1: Add shadcn components**

```bash
cd web
npx shadcn@latest add calendar sheet
```

Verify both `web/components/ui/calendar.tsx` and `web/components/ui/sheet.tsx` exist.

- [ ] **Step 2: Create `StalenessIndicator.tsx`**

```tsx
"use client";
import { cn } from "@/lib/utils";

export function StalenessIndicator({ score }: { score: string | number }) {
  const s = typeof score === "string" ? parseFloat(score) : score;
  const filled = Math.round(s / 2.5); // 0–10 → 0–4 dots
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-sm tabular-nums">{s.toFixed(1)}</span>
      <span className="flex gap-0.5" aria-label={`staleness ${s.toFixed(1)}`}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              "h-2 w-2 rounded-full",
              i < filled ? "bg-orange-500" : "bg-neutral-200",
            )}
          />
        ))}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Create `RefreshFindingsPanel.tsx`**

```tsx
"use client";
import type { RefreshEvaluation } from "@/lib/types";
import { Badge } from "@/components/ui/badge";

export function RefreshFindingsPanel({ ev }: { ev: RefreshEvaluation }) {
  const det = ev.deterministic_findings;
  return (
    <div className="space-y-3 rounded-md border p-4 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={ev.recommended_action === "refresh" ? "destructive" : "secondary"}>
          {ev.recommended_action}
        </Badge>
        <span className="text-neutral-500">
          staleness {Number(ev.staleness_score).toFixed(1)} · {ev.age_days}d old
        </span>
      </div>

      <div>
        <div className="font-medium mb-1">Deterministic findings</div>
        {det.findings.length === 0 ? (
          <p className="text-neutral-500">No deterministic issues.</p>
        ) : (
          <ul className="space-y-1">
            {det.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge variant={f.severity === "high" ? "destructive" : "outline"}>{f.severity}</Badge>
                <span>{f.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {ev.llm_findings ? (
        <div>
          <div className="font-medium mb-1">LLM audit findings</div>
          <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-xs">
            {JSON.stringify(ev.llm_findings, null, 2)}
          </pre>
        </div>
      ) : (
        <div className="text-neutral-500">LLM audit skipped: {ev.llm_skipped_reason ?? "n/a"}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `DismissDialog.tsx`**

```tsx
"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function DismissDialog({
  open, onOpenChange, onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (until: Date, reason: string) => void;
}) {
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [reason, setReason] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Dismiss until…</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Calendar mode="single" selected={date} onSelect={setDate} disabled={(d) => d < new Date()} />
          <div>
            <Label htmlFor="reason">Reason (optional)</Label>
            <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. waiting for product v2 launch" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!date} onClick={() => date && onConfirm(date, reason)}>Dismiss</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Create `ArticleDetailDrawer.tsx`**

```tsx
"use client";
import Link from "next/link";
import type { Article } from "@/lib/types";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { RefreshFindingsPanel } from "./RefreshFindingsPanel";

export function ArticleDetailDrawer({
  article, onClose,
}: {
  article: Article | null;
  onClose: () => void;
}) {
  if (!article) return null;
  const ev = article.latest_evaluation;
  return (
    <Sheet open={!!article} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[480px] sm:w-[560px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">{article.topic || article.article_url}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-4">
          <div className="text-sm text-neutral-600">
            <a href={article.article_url} target="_blank" rel="noopener" className="underline">
              {article.article_url}
            </a>
          </div>
          {ev ? <RefreshFindingsPanel ev={ev} /> : <p className="text-sm text-neutral-500">No evaluation yet.</p>}
          {ev && ev.outcome === "open" && (
            <Link href={`/runs/new?article_id=${article.article_id}&evaluation_id=${ev.evaluation_id}`}>
              <Button className="w-full">Trigger Update</Button>
            </Link>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 6: TypeScript compile check**

```
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/components/ui/calendar.tsx web/components/ui/sheet.tsx web/components/StalenessIndicator.tsx web/components/RefreshFindingsPanel.tsx web/components/DismissDialog.tsx web/components/ArticleDetailDrawer.tsx web/components.json web/package.json web/package-lock.json
git commit -m "feat(web): shadcn calendar+sheet; staleness indicator, findings panel, dismiss dialog, detail drawer"
```

---

### Task 18: Web — `/library` page + LibraryTable

**Files:**
- Create: `web/app/library/page.tsx`
- Create: `web/components/LibraryTable.tsx`

- [ ] **Step 1: Create `web/components/LibraryTable.tsx`**

```tsx
"use client";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { Article } from "@/lib/types";
import { articlesApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { StalenessIndicator } from "./StalenessIndicator";
import { DismissDialog } from "./DismissDialog";
import { ArticleDetailDrawer } from "./ArticleDetailDrawer";

export function LibraryTable({
  filters,
}: {
  filters: { needs_refresh?: boolean; persona?: string; topic_category?: string; q?: string;
             sort?: "staleness" | "next_scan_due" | "last_persisted" };
}) {
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const { data, isLoading } = useQuery({
    queryKey: ["articles", filters, offset],
    queryFn: () => articlesApi.list({ ...filters, limit, offset }),
    refetchInterval: filters.needs_refresh ? 3000 : false,
  });

  const [drawerArticle, setDrawerArticle] = useState<Article | null>(null);
  const [dismissTarget, setDismissTarget] = useState<Article | null>(null);

  const dismissMut = useMutation({
    mutationFn: ({ id, until, reason }: { id: string; until: string; reason: string }) =>
      articlesApi.dismiss(id, until, "editor@bowtie.local", reason),
    onSuccess: () => {
      toast.success("Dismissed");
      qc.invalidateQueries({ queryKey: ["articles"] });
    },
    onError: () => toast.error("Dismiss failed"),
  });

  function dismiss(id: string, until: Date, reason: string) {
    dismissMut.mutate({ id, until: until.toISOString(), reason });
    setDismissTarget(null);
  }

  if (isLoading || !data) return <div className="p-6 text-neutral-500">Loading…</div>;

  return (
    <>
      <table className="w-full text-sm">
        <thead className="border-b text-left text-neutral-500">
          <tr>
            <th className="py-2 pr-3 w-8"></th>
            <th className="py-2 pr-3">Topic / URL</th>
            <th className="py-2 pr-3">Persona</th>
            <th className="py-2 pr-3">Last persisted</th>
            <th className="py-2 pr-3">Staleness</th>
            <th className="py-2 pr-3">Top reason</th>
            <th className="py-2 pr-3 w-32"></th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((a) => {
            const ev = a.latest_evaluation;
            const action = ev?.recommended_action ?? "ok";
            const dot = action === "refresh" ? "bg-orange-500" : action === "monitor" ? "bg-amber-300" : "bg-neutral-200";
            const topReason = ev?.deterministic_findings.findings?.[0]?.message
              ?? (ev?.llm_findings ? "LLM flagged issue" : "—");
            return (
              <tr key={a.article_id} className="border-b cursor-pointer hover:bg-neutral-50"
                  onClick={() => setDrawerArticle(a)}>
                <td className="py-2 pr-3"><span className={`inline-block h-2 w-2 rounded-full ${dot}`} /></td>
                <td className="py-2 pr-3">
                  <div className="font-medium">{a.topic || "(no topic)"}</div>
                  <div className="text-neutral-500 truncate max-w-[36ch]">{a.article_url}</div>
                </td>
                <td className="py-2 pr-3">{a.persona ?? "—"}</td>
                <td className="py-2 pr-3">
                  {a.last_persisted_at
                    ? `${Math.round((Date.now() - new Date(a.last_persisted_at).getTime()) / 86400000)}d ago`
                    : "never"}
                </td>
                <td className="py-2 pr-3">{ev ? <StalenessIndicator score={ev.staleness_score} /> : "—"}</td>
                <td className="py-2 pr-3 max-w-[28ch] truncate">{topReason}</td>
                <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-2">
                    {ev && ev.outcome === "open" && (
                      <Link href={`/runs/new?article_id=${a.article_id}&evaluation_id=${ev.evaluation_id}`}>
                        <Button size="sm">Trigger</Button>
                      </Link>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline">Dismiss ▾</Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {[7, 30, 90].map((d) => (
                          <DropdownMenuItem
                            key={d}
                            onClick={() => dismiss(a.article_id, new Date(Date.now() + d * 86400000), "")}>
                            {d} days
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuItem onClick={() => setDismissTarget(a)}>Custom…</DropdownMenuItem>
                        {a.dismissed_until && (
                          <DropdownMenuItem onClick={() => articlesApi.clearDismiss(a.article_id)
                                .then(() => qc.invalidateQueries({ queryKey: ["articles"] }))}>
                            Clear dismissal
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-4 flex items-center justify-between text-sm text-neutral-500">
        <span>Showing {offset + 1}–{Math.min(offset + limit, data.total)} of {data.total}</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - limit))}>Prev</Button>
          <Button variant="outline" size="sm" disabled={offset + limit >= data.total}
                  onClick={() => setOffset(offset + limit)}>Next</Button>
        </div>
      </div>

      <ArticleDetailDrawer article={drawerArticle} onClose={() => setDrawerArticle(null)} />
      <DismissDialog
        open={!!dismissTarget}
        onOpenChange={(v) => !v && setDismissTarget(null)}
        onConfirm={(until, reason) => dismissTarget && dismiss(dismissTarget.article_id, until, reason)}
      />
    </>
  );
}
```

- [ ] **Step 2: Create `web/app/library/page.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { LibraryTable } from "@/components/LibraryTable";
import { refreshApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";

export default function LibraryPage() {
  const [needsRefresh, setNeedsRefresh] = useState(true);
  const [persona, setPersona] = useState<string>("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"staleness" | "next_scan_due" | "last_persisted">("staleness");

  const scanMut = useMutation({
    mutationFn: refreshApi.scanAll,
    onSuccess: (r) => toast.success(
      `Scanned ${r.scanned} article(s); ${r.evaluations_created} evaluation(s) created.`,
    ),
    onError: (e: Error) => toast.error(`Scan failed: ${e.message}`),
  });

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Library</h1>
        <Button onClick={() => scanMut.mutate()} disabled={scanMut.isPending}>
          {scanMut.isPending ? "Scanning…" : "Run scan now"}
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-neutral-500">Filter</label>
          <Select value={needsRefresh ? "needs_refresh" : "all"} onValueChange={(v) => setNeedsRefresh(v === "needs_refresh")}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="needs_refresh">Needs refresh</SelectItem>
              <SelectItem value="all">All articles</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-neutral-500">Persona</label>
          <Input value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="any" className="w-32" />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-neutral-500">Search</label>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="topic or URL…" />
        </div>
        <div>
          <label className="text-xs text-neutral-500">Sort</label>
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="staleness">Staleness</SelectItem>
              <SelectItem value="next_scan_due">Next scan due</SelectItem>
              <SelectItem value="last_persisted">Last persisted</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <LibraryTable filters={{
        needs_refresh: needsRefresh, persona: persona || undefined, q: q || undefined, sort,
      }} />
    </div>
  );
}
```

- [ ] **Step 3: TypeScript compile + dev-server smoke**

```
cd web && npx tsc --noEmit
npm run dev
# In a browser: visit http://localhost:3000/library
```

Expected: no TS errors. Page renders (may be empty if no articles seeded yet).

- [ ] **Step 4: Commit**

```bash
git add web/app/library/page.tsx web/components/LibraryTable.tsx
git commit -m "feat(web): /library page with table, filters, drawer, dismiss"
```

---

### Task 19: Web — `/runs/new` accepts `?article_id` and `?evaluation_id`

**Files:**
- Modify: `web/app/runs/new/page.tsx`

- [ ] **Step 1: Update the page to read query params**

Open `web/app/runs/new/page.tsx`. At the top, add imports and a search-params hook:

```tsx
"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { refreshApi, articlesApi } from "@/lib/api";
import { RefreshFindingsPanel } from "@/components/RefreshFindingsPanel";
```

Inside the page component, before the existing form state initialisation:

```tsx
const params = useSearchParams();
const articleId = params.get("article_id");
const evaluationId = params.get("evaluation_id");

const { data: article } = useQuery({
  queryKey: ["article", articleId],
  queryFn: () => articleId ? articlesApi.detail(articleId) : Promise.resolve(null),
  enabled: !!articleId,
});

const { data: evaluation } = useQuery({
  queryKey: ["evaluation", evaluationId],
  queryFn: () => evaluationId ? refreshApi.getEvaluation(evaluationId) : Promise.resolve(null),
  enabled: !!evaluationId,
});

useEffect(() => {
  if (!article) return;
  // pre-fill the form state — adapt to whatever the existing useState/useReducer shape is
  setArticleUrl(article.article_url);
  if (article.persona) setPersona(article.persona);
  if (article.topic) setTopic(article.topic);
  if (article.topic_category) setTopicCategory(article.topic_category);
  // mode suggestion based on severity
  if (evaluation?.deterministic_findings?.severity_high && evaluation.deterministic_findings.severity_high > 0) {
    setMode("full_rewrite");
  } else {
    setMode("small_refresh");
  }
}, [article, evaluation]);
```

Above the existing form JSX, render the Refresh context card when `evaluation` is loaded:

```tsx
{evaluation && (
  <div className="mb-6">
    <h2 className="text-sm font-medium mb-2">Refresh context</h2>
    <RefreshFindingsPanel ev={evaluation} />
  </div>
)}
```

In the submit handler, include `triggered_by_evaluation_id` in the API payload:

```tsx
await api.createRun({
  // ... existing fields ...
  triggered_by_evaluation_id: evaluationId ?? undefined,
});
```

- [ ] **Step 2: TS compile + manual smoke**

```
cd web && npx tsc --noEmit
```

Manual smoke: with the dev server running, visit `http://localhost:3000/runs/new?article_id=<known_id>&evaluation_id=<known_id>` (use an article you seed manually or from the library page).

- [ ] **Step 3: Commit**

```bash
git add web/app/runs/new/page.tsx
git commit -m "feat(web): /runs/new prefill + Refresh context card from query params"
```

---

### Task 20: Web — top-bar nav

**Files:**
- Modify: `web/app/layout.tsx`

- [ ] **Step 1: Add top-bar nav**

Open `web/app/layout.tsx`. Inside the root layout, replace whatever currently sits above `{children}` with a top-bar:

```tsx
import Link from "next/link";

// ... inside the layout body, above {children}:
<header className="border-b">
  <div className="mx-auto max-w-6xl px-6 py-3 flex items-center gap-6 text-sm">
    <Link href="/" className="font-semibold">Bowtie Content Tool</Link>
    <nav className="flex items-center gap-4 text-neutral-600">
      <Link href="/" className="hover:text-neutral-900">Runs</Link>
      <Link href="/library" className="hover:text-neutral-900">Library</Link>
    </nav>
  </div>
</header>
```

(Keep the existing `Providers` wrapper. Don't disturb the `<html>` / `<body>` structure.)

- [ ] **Step 2: Visual smoke**

`npm run dev` → visit `/` and `/library`; nav appears on both.

- [ ] **Step 3: Commit**

```bash
git add web/app/layout.tsx
git commit -m "feat(web): top-bar nav with Library link"
```

---

### Task 21: Playwright tests

**Files:**
- Create: `web/tests/library.spec.ts`
- Create: `web/tests/refresh-context.spec.ts`

- [ ] **Step 1: Create `web/tests/library.spec.ts`**

```typescript
import { test, expect } from "@playwright/test";

test("library page renders and trigger button links to /runs/new with query params", async ({ page }) => {
  // Pre-seed via API. Adapt host if your test config differs.
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";
  const url = `https://bowtie.com.hk/playwright/${Date.now()}/`;
  const createRes = await page.request.post(`${apiBase}/runs`, {
    data: {
      article_url: url, topic: "Playwright Library", keywords: [], mode: "small_refresh",
      acf_adv_id: 0, acf_widget_id: 0, persona: "family",
      today_date: new Date().toISOString().slice(0, 10), created_by: "playwright@bowtie",
    },
  });
  expect(createRes.ok()).toBeTruthy();

  // Force a scan so the article gets an evaluation
  const scanRes = await page.request.post(`${apiBase}/refresh/scan`, { data: {} });
  expect(scanRes.ok()).toBeTruthy();

  await page.goto("/library");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  // The filter defaults to "needs_refresh" which may or may not contain the new article
  // depending on staleness — switch to "All" to assert it appears.
  await page.getByText("Needs refresh").click();
  await page.getByRole("option", { name: "All articles" }).click();
  await expect(page.locator("table")).toContainText("Playwright Library");
});
```

- [ ] **Step 2: Create `web/tests/refresh-context.spec.ts`**

```typescript
import { test, expect } from "@playwright/test";

test("/runs/new with article_id + evaluation_id shows Refresh context card", async ({ page }) => {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

  // Mock or pre-seed: this test depends on an article + open evaluation existing.
  // For local Playwright with a real backend, ensure the previous test ran or seed via SQL.
  // For brevity we list the articles, pick the first with an open evaluation.

  const list = await (await page.request.get(`${apiBase}/articles?needs_refresh=true&limit=1`)).json();
  if (list.total === 0) test.skip(true, "no needs-refresh article available; run library.spec.ts first");
  const article = list.items[0];
  const evaluationId = article.latest_evaluation.evaluation_id;

  await page.goto(`/runs/new?article_id=${article.article_id}&evaluation_id=${evaluationId}`);
  await expect(page.getByText("Refresh context")).toBeVisible();
  await expect(page.getByText(article.article_url)).toBeVisible();
});
```

- [ ] **Step 3: Run Playwright tests**

```
cd web
npx playwright test library.spec.ts refresh-context.spec.ts
```

Expected: both PASS. (Backend at `localhost:8000` and dev server at `localhost:3000` must be running; the existing `playwright.config.ts` already starts the Next dev server.)

- [ ] **Step 4: Commit**

```bash
git add web/tests/library.spec.ts web/tests/refresh-context.spec.ts
git commit -m "test(web): playwright — library page and runs/new refresh context"
```

---

### Task 22: README + spec link update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Refresh route section to the root README**

In the appropriate section of `README.md` (alongside the existing route docs), add:

```markdown
## Refresh route (CMS Stage 0)

Periodic re-audit of onboarded articles, surfaced at `/library`.

- **Spec:** `docs/superpowers/specs/2026-05-22-cms-stage-0-refresh-route-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-22-plan-7-refresh-route.md`
- **Cron entrypoint:** `uv run python -m scripts.refresh_scan`
- **Manual scan:** `POST /refresh/scan`
- **Manual single-article:** `POST /refresh/scan/{article_id}`
- **Disable cron without code changes:** set `REFRESH_CRON_ENABLED=false`
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README — refresh route section"
```

---

## Self-review

After completing all tasks, run:

```
uv run pytest -x
cd web && npx tsc --noEmit && npx playwright test
uv run alembic upgrade head
```

Expected: all green. If anything fails, fix and add a regression test before moving on.

**Spec coverage check (run yourself, eyeball each spec section):**

- §2 Goal & scope → Tasks 1–22 cover all in-scope items; out-of-scope explicitly deferred.
- §3 Architecture → Tasks 6–10 (Python modules) + 11–13 (API) + 16–20 (web).
- §4 Data model → Task 2 (models), Task 3 (migration + backfill).
- §5 Scanner algorithm → Tasks 7, 8, 9 (deterministic, evaluator, scanner).
- §6 API surface → Tasks 11 (articles), 12 (refresh), 13 (runs patch).
- §7 Web UI → Tasks 16 (types/api), 17 (components), 18 (page), 19 (runs/new patch), 20 (nav), 21 (Playwright).
- §8 Errors / observability / testing / config → Task 1 (config), Task 9 (scanner logs + advisory lock), Task 14 (cost), Task 15 (cron template).
- §9 Out of scope → not implemented (correctly).
- §10 Open questions → Task 15 documents the cron-host question; other defaults are hard-coded per spec.
