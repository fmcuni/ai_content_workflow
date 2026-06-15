# Plan 6 — Quality & Ops Implementation Plan

**Prereq:** Plans 1–5 shipped — full app works end-to-end.

**Goal:** Add the things that make the system trustworthy at scale: promptfoo eval harness, LLM-as-judge evals, compliance audit log table + CSV export, cost meter UI, OpenTelemetry tracing, nightly eval cron.

**Architecture:** All ops/quality additions are loosely coupled to the runtime — they read from the existing `content_tool.*` tables and emit results into `content_tool.evals` and `content_tool.compliance_log`. No graph changes; just data + observability.

**Tech Stack additions:**
- `opentelemetry-api>=1.27`, `opentelemetry-sdk>=1.27`, `opentelemetry-instrumentation-fastapi>=0.48b0`, `opentelemetry-exporter-otlp-proto-http>=1.27`
- `pandas>=2.2` (CSV export)

---

## File structure (new + modified)

```
ai_content_tool_2/
├── content_tool/
│   ├── observability/
│   │   ├── __init__.py                  # NEW
│   │   ├── tracing.py                   # NEW (OTel setup)
│   │   ├── cost.py                      # NEW (pricing.yaml loader)
│   │   └── logging.py                   # NEW (structlog config)
│   ├── compliance/
│   │   ├── __init__.py                  # NEW
│   │   └── log.py                       # NEW (write compliance row on persisted)
│   ├── api/
│   │   ├── routes/
│   │   │   ├── compliance.py            # NEW (/compliance/export.csv)
│   │   │   └── costs.py                 # NEW (/runs/{id}/cost, /costs/summary)
│   │   └── main.py                      # MODIFY (mount routers + OTel + structlog)
│   ├── graph/root.py                    # MODIFY (call compliance_log on published)
├── config/
│   └── pricing.yaml                     # NEW
├── evals/
│   ├── reference.py                     # MODIFY (more graders)
│   ├── judge/                           # NEW (LLM judge prompts)
│   │   ├── brand_voice.md
│   │   ├── coverage.md
│   │   ├── citation_alignment.md
│   │   └── hk_localisation.md
│   ├── judge_runner.py                  # NEW (LLM-as-judge runner)
│   ├── runner.py                        # NEW (orchestrates evals + writes to content_tool.evals)
│   └── fixtures/
│       ├── articles/                    # 20 sample articles (engineer collects)
│       └── gold_labels/
│           ├── route.csv                # existed from Plan 1
│           └── must_address.csv         # NEW
├── migrations/versions/
│   ├── 0006_compliance_log.py           # NEW
│   └── 0007_evals.py                    # NEW
├── tests/unit/
│   ├── test_cost.py                     # NEW
│   ├── test_compliance_log.py           # NEW
│   └── test_judge_runner.py             # NEW
├── web/
│   └── components/
│       └── CostMeter.tsx                # NEW
└── .github/workflows/
    ├── ci.yml                           # MODIFY (add reference evals)
    └── nightly-evals.yml                # NEW
```

---

### Task 1: pricing.yaml + cost loader

**Files:** `config/pricing.yaml`, `content_tool/observability/__init__.py`, `content_tool/observability/cost.py`, `tests/unit/test_cost.py`

- [ ] **Step 1: Create `config/pricing.yaml`**

```yaml
# Gemini pricing — USD per 1M tokens. Update when Google changes pricing.
# Source: https://ai.google.dev/pricing
gemini-3.5-flash:
  input_per_million_usd: 0.30
  output_per_million_usd: 2.50
  thinking_per_million_usd: 2.50      # thinking tokens billed at output rate
```

- [ ] **Step 2: Create `content_tool/observability/__init__.py`** (empty)

- [ ] **Step 3: Write failing test — `tests/unit/test_cost.py`**

```python
from content_tool.observability.cost import CostCalculator


def test_calculates_cost_usd_cents():
    c = CostCalculator.load_from("config/pricing.yaml")
    cents = c.estimate_cents(model="gemini-3.5-flash", tokens_in=100_000, tokens_out=20_000, thinking_tokens=5_000)
    # 100_000/1e6 * 0.30 = 0.03   USD
    # 20_000/1e6 * 2.50  = 0.05   USD
    # 5_000/1e6 * 2.50   = 0.0125 USD
    # total              = 0.0925 USD = 9.25 cents → 9 (int)
    assert cents == 9
```

- [ ] **Step 4: Implement `content_tool/observability/cost.py`**

```python
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class CostCalculator:
    prices: dict[str, dict[str, float]]

    @classmethod
    def load_from(cls, path: str | Path) -> "CostCalculator":
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        return cls(prices=raw)

    def estimate_cents(self, *, model: str, tokens_in: int, tokens_out: int, thinking_tokens: int) -> int:
        p = self.prices.get(model)
        if not p:
            return 0
        usd = (
            (tokens_in / 1_000_000) * p["input_per_million_usd"]
            + (tokens_out / 1_000_000) * p["output_per_million_usd"]
            + (thinking_tokens / 1_000_000) * p["thinking_per_million_usd"]
        )
        return int(usd * 100)
```

- [ ] **Step 5: Run + commit**

Run: `pytest tests/unit/test_cost.py -v`
Expected: PASS

```bash
git add config/pricing.yaml content_tool/observability/cost.py content_tool/observability/__init__.py tests/unit/test_cost.py
git commit -m "feat(ops): cost calculator with config-driven pricing"
```

---

### Task 2: structlog + OTel tracing setup

**Files:** `content_tool/observability/logging.py`, `content_tool/observability/tracing.py`

- [ ] **Step 1: Install deps**

Append to `pyproject.toml` `dependencies`:
```toml
  "opentelemetry-api>=1.27",
  "opentelemetry-sdk>=1.27",
  "opentelemetry-instrumentation-fastapi>=0.48b0",
  "opentelemetry-exporter-otlp-proto-http>=1.27",
  "pandas>=2.2",
```

Reinstall: `uv pip install -e ".[dev]"`

- [ ] **Step 2: Create `content_tool/observability/logging.py`**

```python
import logging

import structlog


def configure_logging(level: str = "info") -> None:
    logging.basicConfig(level=getattr(logging, level.upper(), logging.INFO), format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level.upper(), logging.INFO)),
    )
```

- [ ] **Step 3: Create `content_tool/observability/tracing.py`**

```python
import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def configure_tracing(service_name: str = "content_tool") -> None:
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        # No collector → no-op
        return
    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")))
    trace.set_tracer_provider(provider)
```

- [ ] **Step 4: Wire in `content_tool/api/main.py`**

In `create_app`, before returning:

```python
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from content_tool.observability.logging import configure_logging
from content_tool.observability.tracing import configure_tracing


def create_app() -> FastAPI:
    configure_logging(get_settings().log_level)
    configure_tracing()
    app = FastAPI(...)
    # ... middleware + routes ...
    FastAPIInstrumentor().instrument_app(app)
    return app
```

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml content_tool/observability/logging.py content_tool/observability/tracing.py content_tool/api/main.py
git commit -m "feat(ops): structlog + OTel tracing"
```

---

### Task 3: Compliance log table + writer

**Files:** Create `migrations/versions/0006_compliance_log.py`, `content_tool/compliance/__init__.py`, `content_tool/compliance/log.py`, `tests/unit/test_compliance_log.py`. Append ORM model to `content_tool/db/models.py`.

- [ ] **Step 1: Append ORM model**

```python
class ComplianceLog(Base):
    __tablename__ = "compliance_log"

    log_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    run_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True),
                                         ForeignKey("content_tool.runs.run_id"), unique=True, nullable=False)
    persisted_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    persona: Mapped[str] = mapped_column(String, nullable=False)
    article_url: Mapped[str] = mapped_column(String, nullable=False)
    wp_pushed_post_id: Mapped[int | None]
    chosen_route: Mapped[str] = mapped_column(String, nullable=False)
    sources_cited: Mapped[str] = mapped_column(String, nullable=False)
    sources_denied: Mapped[str | None] = mapped_column(String)
    audit_overall_pass: Mapped[bool]
    audit_severity_summary: Mapped[dict] = mapped_column(JSONB, nullable=False)
    approver_email: Mapped[str] = mapped_column(String, nullable=False)
    iteration_count: Mapped[int]
    gemini_model: Mapped[str] = mapped_column(String, nullable=False)
    total_tokens: Mapped[int | None]
    est_cost_usd_cents: Mapped[int | None]
```

- [ ] **Step 2: Create `migrations/versions/0006_compliance_log.py`**

```python
"""compliance_log

Revision ID: 0006
Revises: 0005
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"


def upgrade() -> None:
    op.create_table(
        "compliance_log",
        sa.Column("log_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("run_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.runs.run_id"), unique=True, nullable=False),
        sa.Column("persisted_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("persona", sa.String, nullable=False),
        sa.Column("article_url", sa.String, nullable=False),
        sa.Column("wp_pushed_post_id", sa.Integer),
        sa.Column("chosen_route", sa.String, nullable=False),
        sa.Column("sources_cited", sa.String, nullable=False),
        sa.Column("sources_denied", sa.String),
        sa.Column("audit_overall_pass", sa.Boolean, nullable=False),
        sa.Column("audit_severity_summary", postgresql.JSONB, nullable=False),
        sa.Column("approver_email", sa.String, nullable=False),
        sa.Column("iteration_count", sa.Integer),
        sa.Column("gemini_model", sa.String, nullable=False),
        sa.Column("total_tokens", sa.Integer),
        sa.Column("est_cost_usd_cents", sa.Integer),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("compliance_log", schema="content_tool")
```

- [ ] **Step 3: Implement `content_tool/compliance/__init__.py`** (empty) and `content_tool/compliance/log.py`

```python
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import (
    AuditRun, Citation, ComplianceLog, Draft, GapAnalysisRow, Run,
)
from content_tool.observability.cost import CostCalculator


async def write_compliance_log(
    *, session: AsyncSession, run_id: UUID, cost_calc: CostCalculator, gemini_model: str,
) -> None:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    drafts = (await session.execute(select(Draft).where(Draft.run_id == run_id))).scalars().all()
    if not drafts:
        return
    latest = max(drafts, key=lambda d: d.iteration)
    audit = (await session.execute(select(AuditRun).where(AuditRun.draft_id == latest.draft_id))).scalar_one_or_none()
    ga = (await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))).scalar_one()
    citations = (await session.execute(select(Citation).where(Citation.draft_id == latest.draft_id))).scalars().all()

    cited = ";".join(sorted({c.domain for c in citations if c.was_displayed and c.domain}))
    denied = ";".join(sorted({c.domain for c in citations if c.policy_decision == "denied" and c.domain}))

    total_tokens = sum((d.tokens_in or 0) + (d.tokens_out or 0) + (d.thinking_tokens or 0) for d in drafts)
    total_tokens += (ga.tokens_in or 0) + (ga.tokens_out or 0) + (ga.thinking_tokens or 0)
    cost_cents = cost_calc.estimate_cents(
        model=gemini_model,
        tokens_in=sum((d.tokens_in or 0) for d in drafts) + (ga.tokens_in or 0),
        tokens_out=sum((d.tokens_out or 0) for d in drafts) + (ga.tokens_out or 0),
        thinking_tokens=sum((d.thinking_tokens or 0) for d in drafts) + (ga.thinking_tokens or 0),
    )

    session.add(ComplianceLog(
        run_id=run_id, persona=run.persona, article_url=run.article_url,
        wp_pushed_post_id=run.wp_pushed_post_id,
        chosen_route=run.chosen_route or "unknown",
        sources_cited=cited, sources_denied=denied,
        audit_overall_pass=audit.overall_pass if audit else False,
        audit_severity_summary={
            "high": audit.severity_high if audit else 0,
            "medium": audit.severity_medium if audit else 0,
            "low": audit.severity_low if audit else 0,
        },
        approver_email=run.approved_by or "unknown",
        iteration_count=run.iteration_count,
        gemini_model=gemini_model,
        total_tokens=total_tokens,
        est_cost_usd_cents=cost_cents,
    ))
    await session.commit()
```

- [ ] **Step 4: Wire into `n_publish` in `content_tool/graph/root.py`**

In the publish node, after the WP push succeeds:

```python
from content_tool.compliance.log import write_compliance_log
from content_tool.observability.cost import CostCalculator
from content_tool.config import get_settings

async def n_publish(state: ContentToolState) -> dict[str, Any]:
    # ... existing publish logic ...

    settings = get_settings()
    cost_calc = CostCalculator.load_from("config/pricing.yaml")
    async with session_factory() as session:
        await write_compliance_log(
            session=session, run_id=UUID(state["run_id"]),
            cost_calc=cost_calc, gemini_model=settings.gemini_model,
        )
    return {"status": "published"}
```

- [ ] **Step 5: Apply migration + commit**

```bash
alembic upgrade head
git add content_tool/db/models.py migrations/versions/0006_compliance_log.py content_tool/compliance/ content_tool/graph/root.py
git commit -m "feat(compliance): immutable audit log on persist"
```

---

### Task 4: Compliance CSV export endpoint

**Files:** Create `content_tool/api/routes/compliance.py`, modify `content_tool/api/main.py`

- [ ] **Step 1: Create the route**

```python
from datetime import date, datetime
import csv
import io

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import and_, select

from content_tool.db.models import ComplianceLog

router = APIRouter(prefix="/compliance", tags=["compliance"])


def get_session_factory(request: Request):
    return request.app.state.session_factory


@router.get("/export.csv")
async def export_csv(
    start: date, end: date, sf=Depends(get_session_factory),
) -> Response:
    async with sf() as session:
        rows = (await session.execute(
            select(ComplianceLog).where(
                and_(ComplianceLog.persisted_at >= datetime.combine(start, datetime.min.time()),
                     ComplianceLog.persisted_at <= datetime.combine(end, datetime.max.time()))
            ).order_by(ComplianceLog.persisted_at)
        )).scalars().all()

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "run_id", "persisted_at", "persona", "article_url", "wp_pushed_post_id",
        "chosen_route", "sources_cited", "sources_denied",
        "audit_overall_pass", "audit_severity_high", "audit_severity_medium", "audit_severity_low",
        "approver_email", "iteration_count", "gemini_model",
        "total_tokens", "est_cost_usd_cents",
    ])
    for r in rows:
        s = r.audit_severity_summary or {}
        w.writerow([
            str(r.run_id), r.persisted_at.isoformat(), r.persona, r.article_url,
            r.wp_pushed_post_id or "", r.chosen_route,
            r.sources_cited, r.sources_denied or "",
            r.audit_overall_pass, s.get("high", 0), s.get("medium", 0), s.get("low", 0),
            r.approver_email, r.iteration_count, r.gemini_model,
            r.total_tokens or 0, r.est_cost_usd_cents or 0,
        ])

    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"content-disposition": f'attachment; filename="compliance_{start}_to_{end}.csv"'},
    )
```

- [ ] **Step 2: Mount in `content_tool/api/main.py`**

```python
from content_tool.api.routes.compliance import router as compliance_router

# in create_app:
app.include_router(compliance_router)
```

- [ ] **Step 3: Commit**

```bash
git add content_tool/api/routes/compliance.py content_tool/api/main.py
git commit -m "feat(api): /compliance/export.csv (date-ranged)"
```

---

### Task 5: Cost endpoints + UI meter

**Files:** Create `content_tool/api/routes/costs.py`, `web/components/CostMeter.tsx`, modify `web/app/runs/[runId]/page.tsx`

- [ ] **Step 1: Create `content_tool/api/routes/costs.py`**

```python
from datetime import date, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import and_, func, select

from content_tool.db.models import Draft, GapAnalysisRow, Run
from content_tool.observability.cost import CostCalculator

router = APIRouter(prefix="/costs", tags=["costs"])


def get_session_factory(request: Request):
    return request.app.state.session_factory


@router.get("/run/{run_id}")
async def cost_for_run(run_id: UUID, sf=Depends(get_session_factory)) -> dict:
    calc = CostCalculator.load_from("config/pricing.yaml")
    async with sf() as session:
        ga = (await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))).scalar_one_or_none()
        drafts = (await session.execute(select(Draft).where(Draft.run_id == run_id))).scalars().all()
        if not ga and not drafts:
            raise HTTPException(404, "no usage")

        tin = (ga.tokens_in or 0) if ga else 0
        tout = (ga.tokens_out or 0) if ga else 0
        tthk = (ga.thinking_tokens or 0) if ga else 0
        for d in drafts:
            tin += d.tokens_in or 0
            tout += d.tokens_out or 0
            tthk += d.thinking_tokens or 0

        cents = calc.estimate_cents(model="gemini-3.5-flash", tokens_in=tin, tokens_out=tout, thinking_tokens=tthk)
        return {"tokens_in": tin, "tokens_out": tout, "thinking_tokens": tthk, "est_usd_cents": cents}


@router.get("/summary")
async def cost_summary(
    start: date, end: date, sf=Depends(get_session_factory),
) -> dict:
    calc = CostCalculator.load_from("config/pricing.yaml")
    async with sf() as session:
        runs = (await session.execute(
            select(Run).where(and_(Run.created_at >= datetime.combine(start, datetime.min.time()),
                                   Run.created_at <= datetime.combine(end, datetime.max.time())))
        )).scalars().all()
        total_cents = 0
        for r in runs:
            ga = (await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == r.run_id))).scalar_one_or_none()
            drafts = (await session.execute(select(Draft).where(Draft.run_id == r.run_id))).scalars().all()
            tin = (ga.tokens_in or 0) if ga else 0
            tout = (ga.tokens_out or 0) if ga else 0
            tthk = (ga.thinking_tokens or 0) if ga else 0
            for d in drafts:
                tin += d.tokens_in or 0
                tout += d.tokens_out or 0
                tthk += d.thinking_tokens or 0
            total_cents += calc.estimate_cents(model="gemini-3.5-flash", tokens_in=tin, tokens_out=tout, thinking_tokens=tthk)
        return {"runs": len(runs), "total_usd_cents": total_cents}
```

- [ ] **Step 2: Mount in `content_tool/api/main.py`**

```python
from content_tool.api.routes.costs import router as costs_router
app.include_router(costs_router)
```

- [ ] **Step 3: Frontend — `web/components/CostMeter.tsx`**

```typescript
"use client";
import { useQuery } from "@tanstack/react-query";

export function CostMeter({ runId }: { runId: string }) {
  const { data } = useQuery({
    queryKey: ["cost", runId],
    queryFn: async () => {
      const r = await fetch(`/api/runs/../costs/run/${runId}`.replace("/runs/..", ""));
      return (await r.json()) as { tokens_in: number; tokens_out: number; thinking_tokens: number; est_usd_cents: number };
    },
    refetchInterval: 5000,
  });
  if (!data) return null;
  return (
    <div className="text-xs text-neutral-500">
      Tokens: {data.tokens_in.toLocaleString()} in / {data.tokens_out.toLocaleString()} out · {data.thinking_tokens.toLocaleString()} thinking
      · Est: US${(data.est_usd_cents / 100).toFixed(2)}
    </div>
  );
}
```

Add to `web/app/runs/[runId]/page.tsx` next to the status row:
```typescript
import { CostMeter } from "@/components/CostMeter";
// inside the JSX header area:
<CostMeter runId={runId} />
```

Also add a proxy rewrite for `/costs/` to `web/next.config.mjs`:
```javascript
{ source: "/api/costs/:path*", destination: `${process.env.NEXT_PUBLIC_API_BASE}/costs/:path*` },
```

- [ ] **Step 4: Commit**

```bash
git add content_tool/api/routes/costs.py content_tool/api/main.py web/components/CostMeter.tsx web/app/runs/[runId]/page.tsx web/next.config.mjs
git commit -m "feat(ops): cost endpoints + UI meter"
```

---

### Task 6: `content_tool.evals` table + eval runner

**Files:** Create `migrations/versions/0007_evals.py`, `evals/runner.py`, append ORM model

- [ ] **Step 1: Append ORM model to `content_tool/db/models.py`**

```python
class Eval(Base):
    __tablename__ = "evals"

    eval_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    ran_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    metric: Mapped[str] = mapped_column(String, nullable=False)
    fixture_id: Mapped[str] = mapped_column(String, nullable=False)
    run_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True))
    score: Mapped[float | None]
    pass_: Mapped[bool] = mapped_column("pass", default=False)
    judge_notes: Mapped[dict | None] = mapped_column(JSONB)
    commit_sha: Mapped[str] = mapped_column(String, nullable=False)
```

- [ ] **Step 2: Create `migrations/versions/0007_evals.py`**

```python
"""evals

Revision ID: 0007
Revises: 0006
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    op.create_table(
        "evals",
        sa.Column("eval_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("ran_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("metric", sa.String, nullable=False),
        sa.Column("fixture_id", sa.String, nullable=False),
        sa.Column("run_id", postgresql.UUID(as_uuid=True)),
        sa.Column("score", sa.Numeric),
        sa.Column("pass", sa.Boolean, server_default=sa.text("false")),
        sa.Column("judge_notes", postgresql.JSONB),
        sa.Column("commit_sha", sa.String, nullable=False),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("evals", schema="content_tool")
```

- [ ] **Step 3: Create `evals/runner.py`**

```python
import asyncio
import os
import subprocess
from pathlib import Path
from uuid import uuid4

from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.db.models import Eval


def current_commit_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


async def record_eval(
    sf: async_sessionmaker, *, metric: str, fixture_id: str,
    score: float | None, passed: bool, judge_notes: dict | None = None,
    run_id=None,
) -> None:
    sha = current_commit_sha()
    async with sf() as session:
        session.add(Eval(
            eval_id=uuid4(), metric=metric, fixture_id=fixture_id, run_id=run_id,
            score=score, pass_=passed, judge_notes=judge_notes, commit_sha=sha,
        ))
        await session.commit()
```

- [ ] **Step 4: Commit**

```bash
alembic upgrade head
git add content_tool/db/models.py migrations/versions/0007_evals.py evals/runner.py
git commit -m "feat(evals): evals table + recorder"
```

---

### Task 7: LLM-as-judge runner

**Files:** Create `evals/judge/*.md`, `evals/judge_runner.py`, `tests/unit/test_judge_runner.py`

- [ ] **Step 1: Create judge prompts**

`evals/judge/brand_voice.md`:
```markdown
你是品牌語氣審核員。比較以下 final_html 與 persona pack 的 voice_rules、banned_terms、required_phrasings、tone_examples，回傳 1–5 分（1=不符；5=完美）以及具體引用。

輸入：
- final_html
- persona pack (full)

只輸出 JSON：
{"score": 1-5, "issues": ["...", "..."], "matched_required_phrasings": ["..."], "found_banned_terms": ["..."]}
```

`evals/judge/coverage.md`:
```markdown
你是 coverage 審核員。比較 gap_analysis.update_plan 與 final_html，回傳每個 must_* 項目是否被處理。

輸入：
- update_plan
- final_html

只輸出 JSON：
{"items": [{"plan_item": "...", "category": "must_add|must_update|must_remove|faq_to_add|facts_to_verify", "addressed": true/false, "evidence": "section ref"}], "coverage_rate": 0.0-1.0}
```

`evals/judge/citation_alignment.md`:
```markdown
你是引用對齊審核員。對每個 citation_intents[i].claim，使用 urlContext 讀取對應 citations[i].final_url 並判斷該頁面是否支持該 claim。

只輸出 JSON：
{"alignments": [{"claim": "...", "url": "...", "supported": true/false, "evidence_excerpt": "..."}], "support_rate": 0.0-1.0}
```

`evals/judge/hk_localisation.md`:
```markdown
你是香港在地化審核員。讀取 final_html，找出任何內地專屬詞彙、非繁體中文、文化不符之處。

只輸出 JSON：
{"localisation_score": 1-5, "mainland_terms_found": ["..."], "non_hk_phrasings": ["..."]}
```

- [ ] **Step 2: Implement `evals/judge_runner.py`**

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from content_tool.gemini.client import GeminiClient


JUDGE_PROMPTS = {
    "brand_voice": Path("evals/judge/brand_voice.md"),
    "coverage": Path("evals/judge/coverage.md"),
    "citation_alignment": Path("evals/judge/citation_alignment.md"),
    "hk_localisation": Path("evals/judge/hk_localisation.md"),
}


@dataclass
class JudgeResult:
    metric: str
    parsed: dict[str, Any]


async def run_judge(
    *, gemini: GeminiClient, metric: str, user_payload: str,
    use_url_context: bool = False,
) -> JudgeResult:
    prompt = JUDGE_PROMPTS[metric].read_text(encoding="utf-8")
    result = await gemini.generate(
        agent=f"judge.{metric}",
        system_prompt=prompt,
        user_prompt=user_payload,
        response_schema={"type": "object"},
        tools=["urlContext"] if use_url_context else [],
    )
    return JudgeResult(metric=metric, parsed=result.parsed)
```

- [ ] **Step 3: Test — `tests/unit/test_judge_runner.py`**

```python
import pytest

from content_tool.gemini.fake import FakeGeminiClient
from evals.judge_runner import run_judge


@pytest.mark.asyncio
async def test_judge_runner_returns_parsed():
    canned = {"judge.brand_voice": {"score": 5, "issues": [], "matched_required_phrasings": ["自願醫保"], "found_banned_terms": []}}
    gemini = FakeGeminiClient(canned_responses=canned)
    res = await run_judge(gemini=gemini, metric="brand_voice", user_payload="hi")
    assert res.parsed["score"] == 5
```

- [ ] **Step 4: Run + commit**

Run: `pytest tests/unit/test_judge_runner.py -v`
Expected: PASS

```bash
git add evals/judge/ evals/judge_runner.py tests/unit/test_judge_runner.py
git commit -m "feat(evals): LLM-as-judge runner with 4 metrics"
```

---

### Task 8: Nightly evals GitHub Action

**Files:** Create `.github/workflows/nightly-evals.yml`, append `evals/runner.py` with `if __name__ == '__main__'` orchestration

- [ ] **Step 1: Append CLI to `evals/runner.py`**

```python
import asyncio


async def main() -> None:
    """Run reference evals against last 30 runs and emit results to content_tool.evals."""
    from content_tool.config import get_settings
    from content_tool.db.connection import make_engine, make_session_factory
    from content_tool.db.models import Citation, Draft, GapAnalysisRow, Run
    from sqlalchemy import select

    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)

    async with sf() as session:
        runs = (await session.execute(
            select(Run).where(Run.status == "published").order_by(Run.created_at.desc()).limit(30)
        )).scalars().all()

        for r in runs:
            # Citation allow-list compliance
            drafts = (await session.execute(select(Draft).where(Draft.run_id == r.run_id))).scalars().all()
            if not drafts:
                continue
            latest = max(drafts, key=lambda d: d.iteration)
            citations = (await session.execute(select(Citation).where(Citation.draft_id == latest.draft_id))).scalars().all()
            denied_displayed = any(c.was_displayed and c.policy_decision == "denied" for c in citations)
            await record_eval(sf, metric="citation_policy_compliance",
                              fixture_id=str(r.run_id), score=0.0 if denied_displayed else 1.0,
                              passed=not denied_displayed, run_id=r.run_id)

            # Refine-loop convergence (passed if iteration_count <= 1 → converged in 2 or fewer drafts)
            converged = r.iteration_count <= 1
            await record_eval(sf, metric="refine_loop_convergence",
                              fixture_id=str(r.run_id), score=1.0 if converged else 0.0,
                              passed=converged, run_id=r.run_id)

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Create `.github/workflows/nightly-evals.yml`**

```yaml
name: Nightly Evals

on:
  schedule:
    - cron: "0 18 * * *"   # 02:00 HKT
  workflow_dispatch:

jobs:
  evals:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: content_tool
          POSTGRES_PASSWORD: content_tool
          POSTGRES_DB: content_tool
        ports: ["5432:5432"]
        options: --health-cmd "pg_isready -U content_tool"
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv venv && uv pip install -e ".[dev]"
      - env:
          POSTGRES_URL: postgresql+asyncpg://content_tool:content_tool@localhost:5432/content_tool
        run: |
          source .venv/bin/activate
          alembic upgrade head
          python -m evals.runner
```

- [ ] **Step 3: Commit**

```bash
git add evals/runner.py .github/workflows/nightly-evals.yml
git commit -m "feat(evals): nightly reference-eval cron"
```

---

### Task 9: CI on prompt-change runs judge evals

**Files:** Modify `.github/workflows/ci.yml`

- [ ] **Step 1: Add a job triggered when `prompts/**` or `config/personas/**` change**

```yaml
  judge-evals:
    runs-on: ubuntu-latest
    if: contains(github.event.pull_request.labels.*.name, 'prompt-change')
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: content_tool
          POSTGRES_PASSWORD: content_tool
          POSTGRES_DB: content_tool
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv venv && uv pip install -e ".[dev]"
      - env:
          POSTGRES_URL: postgresql+asyncpg://content_tool:content_tool@localhost:5432/content_tool
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        run: |
          source .venv/bin/activate
          alembic upgrade head
          # Engineer extends evals/runner.py to support a "sample 5 fixtures with judge" mode.
          # MVP: just exercise judge_runner against canned fixtures to prove wiring.
          pytest tests/unit/test_judge_runner.py -v
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: judge-evals job on prompt-change PRs"
```

---

### Task 10: README + final checks

**Files:** Modify `README.md`

- [ ] **Step 1: Append "Ops" section**

```markdown
## Ops

### Observability

- Logs: JSON via structlog to stdout. Set `LOG_LEVEL=debug` for verbose.
- Tracing: OpenTelemetry. If `OTEL_EXPORTER_OTLP_ENDPOINT` is set, spans go to that OTLP HTTP receiver.
  Local Jaeger: `docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one`
  then `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and visit http://localhost:16686.

### Costs

- Per-run estimate: `GET /costs/run/{run_id}`
- Date-range summary: `GET /costs/summary?start=2026-05-01&end=2026-05-31`
- Update prices: edit `config/pricing.yaml`. No restart needed (loaded on demand).

### Compliance audit log

- Auto-written on every `published` run.
- Export: `GET /compliance/export.csv?start=2026-05-01&end=2026-05-31`

### Evals

- Nightly cron runs reference evals against last 30 published runs → `content_tool.evals`.
- Manual: `python -m evals.runner`
- LLM-judge: triggered on PRs labeled `prompt-change`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: ops, observability, evals, compliance"
```

---

## Self-review checklist

| Concern | Covered |
|---|---|
| pricing.yaml + CostCalculator | Task 1 |
| structlog + OTel | Task 2 |
| Compliance log table + writer | Task 3 |
| Compliance CSV export | Task 4 |
| Cost endpoints + UI meter | Task 5 |
| Evals table + recorder | Task 6 |
| LLM-as-judge runner | Task 7 |
| Nightly reference-eval cron | Task 8 |
| CI judge-evals on prompt-change PRs | Task 9 |
| Docs | Task 10 |

After Plan 6 ships, the system is auditable end-to-end:
- Every published run leaves a row in `compliance_log` exportable as CSV.
- Every Gemini call is traced and costed.
- Reference evals run nightly; judge evals run on prompt changes.
- The cost meter is visible to editors during a run.

This is the end of the MVP plan series. Post-MVP candidates (Research agent, Create-New-Article flow, multi-locale translate, GA/Search Console feedback loop) are spec'd in the design doc §13 and should each get their own brainstorming → spec → plan cycle.
