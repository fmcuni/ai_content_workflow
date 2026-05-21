# Plan 2 — Strategy Subgraph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prereq:** Plan 1 shipped.

**Goal:** Compose the LangGraph Strategy subgraph (gap_analysis → outline), wire in HITL_1 interrupt, add the `fetch_article` node (real WordPress REST), expose `POST /runs` + `GET /runs/{id}/events` (SSE) + `POST /runs/{id}/resume`, and stream events end-to-end via curl with a fake Gemini.

**Architecture:** Introduce LangGraph with a Postgres checkpointer. `ContentToolState` TypedDict shared by all nodes. Strategy subgraph as a compiled subgraph composed into a root graph. HITL_1 implemented via `interrupt_before=["outline"]` so the editor can edit the gap analysis before outline runs (alternative considered: post-outline interrupt — went with post-outline interrupt as in spec §9, easier to edit the structured outline directly). Streaming via LangGraph's `astream` mapped to SSE.

**Tech Stack additions on top of Plan 1:**
- `langgraph>=0.2.50`
- `langgraph-checkpoint-postgres>=2.0`
- `markdownify>=0.13`
- `beautifulsoup4>=4.12`
- `sse-starlette>=2.1`

---

## File structure (new + modified)

```
ai_content_tool_2/
├── pyproject.toml                                  # MODIFY: add deps
├── content_tool/
│   ├── models/
│   │   ├── outline.py                              # NEW
│   │   └── state.py                                # NEW
│   ├── agents/
│   │   ├── outline.py                              # NEW
│   │   └── fetch_article.py                        # NEW
│   ├── graph/
│   │   ├── __init__.py                             # NEW
│   │   ├── strategy.py                             # NEW (Strategy subgraph)
│   │   ├── root.py                                 # NEW (root graph w/ HITL)
│   │   └── checkpointer.py                         # NEW
│   ├── api/
│   │   ├── routes/runs.py                          # MODIFY: full CRUD + SSE + resume
│   │   ├── schemas.py                              # NEW (Pydantic request/response)
│   │   └── sse.py                                  # NEW (LangGraph events → SSE adapter)
│   ├── db/models.py                                # MODIFY: add Outline, FetchedArticle
├── prompts/
│   └── outline.md                                  # NEW
├── migrations/versions/
│   └── 0002_fetched_articles_and_outlines.py       # NEW
└── tests/
    ├── fixtures/
    │   ├── gemini_responses/outline_ok.json        # NEW
    │   └── wp_responses/                           # NEW
    │       ├── post_response.json
    │       └── categories_response.json
    ├── unit/
    │   ├── test_outline_schema.py                  # NEW
    │   └── test_strategy_graph_compose.py          # NEW
    └── integration/
        ├── test_fetch_article_node.py              # NEW
        ├── test_outline_node.py                    # NEW
        ├── test_strategy_subgraph_e2e.py           # NEW
        └── test_api_runs.py                        # NEW (POST /runs, SSE, resume)
```

---

### Task 1: Install LangGraph + related deps

**Files:** Modify `pyproject.toml`

- [ ] **Step 1: Modify `pyproject.toml` — append to `dependencies`**

```toml
  "langgraph>=0.2.50",
  "langgraph-checkpoint-postgres>=2.0",
  "markdownify>=0.13",
  "beautifulsoup4>=4.12",
  "sse-starlette>=2.1",
```

- [ ] **Step 2: Reinstall**

Run:
```bash
uv pip install -e ".[dev]"
```

- [ ] **Step 3: Smoke import test**

Run: `python -c "from langgraph.graph import StateGraph; from langgraph.checkpoint.postgres import AsyncPostgresSaver; print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml
git commit -m "chore: add LangGraph + markdownify + sse-starlette deps"
```

---

### Task 2: ContentToolState TypedDict

**Files:**
- Create: `content_tool/models/state.py`
- Create: `tests/unit/test_state_shape.py`

- [ ] **Step 1: Write failing test — `tests/unit/test_state_shape.py`**

```python
from datetime import date

from content_tool.models.state import ContentToolState


def test_state_accepts_minimal_input():
    s: ContentToolState = {
        "run_id": "00000000-0000-0000-0000-000000000000",
        "article_url": "https://e.com",
        "topic": "x",
        "keywords": ["a"],
        "mode": "auto",
        "edit_note": None,
        "acf_adv_id": 1,
        "acf_widget_id": 2,
        "persona": "bowtie-editor",
        "topic_category": None,
        "today_date": date(2026, 5, 21).isoformat(),
        "existing_article_markdown": None,
        "wp_post_id": None,
        "wp_categories": None,
        "gap_analysis": None,
        "outline": None,
        "chosen_route": None,
        "writer_output": None,
        "grounding_chunks": None,
        "citations": None,
        "render": None,
        "final_markup": None,
        "audit_findings": None,
        "iteration": 0,
        "hitl_1_decision": None,
        "hitl_1_edits": None,
        "hitl_2_decision": None,
        "hitl_2_notes": None,
        "status": "pending",
        "error": None,
    }
    assert s["run_id"].startswith("0000")
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement `content_tool/models/state.py`**

```python
from typing import Any, Literal, TypedDict


class ContentToolState(TypedDict):
    # input
    run_id: str
    article_url: str
    topic: str
    keywords: list[str]
    mode: Literal["auto", "small_refresh", "full_rewrite"]
    edit_note: str | None
    acf_adv_id: int
    acf_widget_id: int
    persona: str
    topic_category: str | None
    today_date: str

    # fetched
    existing_article_markdown: str | None
    wp_post_id: int | None
    wp_categories: list[dict[str, Any]] | None

    # strategy
    gap_analysis: dict[str, Any] | None
    outline: dict[str, Any] | None
    chosen_route: Literal["small_refresh", "full_rewrite"] | None

    # production (filled by Plan 3)
    writer_output: dict[str, Any] | None
    grounding_chunks: list[dict[str, Any]] | None
    citations: list[dict[str, Any]] | None
    render: dict[str, Any] | None
    final_markup: str | None
    audit_findings: dict[str, Any] | None
    iteration: int

    # HITL
    hitl_1_decision: str | None
    hitl_1_edits: dict[str, Any] | None
    hitl_2_decision: str | None
    hitl_2_notes: str | None

    # lifecycle
    status: str
    error: dict[str, Any] | None
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit**

```bash
git add content_tool/models/state.py tests/unit/test_state_shape.py
git commit -m "feat: ContentToolState TypedDict"
```

---

### Task 3: Outline Pydantic schema

**Files:**
- Create: `content_tool/models/outline.py`, `tests/unit/test_outline_schema.py`, `tests/fixtures/gemini_responses/outline_ok.json`

- [ ] **Step 1: Create fixture `tests/fixtures/gemini_responses/outline_ok.json`**

```json
{
  "h1": "大腸癌：症狀、篩查、治療與保險指南（2026）",
  "meta_description_hint": "了解大腸癌的早期症狀、篩查方法、治療選擇及香港保險保障，附自願醫保比較。",
  "sections": [
    {"heading_level": 2, "heading_text": "什麼是大腸癌？", "action": "keep", "intent": "definition", "key_points": ["定義", "成因"], "format_hint": "paragraph", "source_note": null},
    {"heading_level": 2, "heading_text": "大腸癌篩查方法", "action": "update", "intent": "screening", "key_points": ["大便潛血", "大腸鏡"], "format_hint": "numbered", "source_note": "vhis.gov.hk"},
    {"heading_level": 2, "heading_text": "標靶與免疫治療 (新增)", "action": "add", "intent": "treatment-advanced", "key_points": ["MSI-H", "KRAS"], "format_hint": "table", "source_note": null}
  ],
  "faq_section": [
    {"question": "篩查資格是什麼？", "answer_intent": "list 50-75 HK residents eligibility", "action": "add"}
  ],
  "shortcode_positions": {"adv_panel_after_section_index": 0, "page_widget_before": "faq"}
}
```

- [ ] **Step 2: Write failing test — `tests/unit/test_outline_schema.py`**

```python
import json
from pathlib import Path

from content_tool.models.outline import Outline


def test_outline_parses():
    data = json.loads(Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8"))
    o = Outline.model_validate(data)
    assert o.h1.startswith("大腸癌")
    assert len(o.sections) == 3
    assert o.sections[2].action == "add"
    assert o.shortcode_positions.page_widget_before == "faq"
```

- [ ] **Step 3: Run — fails**

- [ ] **Step 4: Implement `content_tool/models/outline.py`**

```python
from typing import Literal

from pydantic import BaseModel


class OutlineSection(BaseModel):
    heading_level: Literal[2, 3]
    heading_text: str
    action: Literal["keep", "update", "add", "remove", "reorder"]
    intent: str
    key_points: list[str]
    format_hint: Literal["paragraph", "bullet", "numbered", "table"]
    source_note: str | None = None


class FaqItem(BaseModel):
    question: str
    answer_intent: str
    action: Literal["keep", "update", "add", "remove"]


class ShortcodePositions(BaseModel):
    adv_panel_after_section_index: int
    page_widget_before: Literal["faq"]


class Outline(BaseModel):
    h1: str
    meta_description_hint: str
    sections: list[OutlineSection]
    faq_section: list[FaqItem]
    shortcode_positions: ShortcodePositions
```

- [ ] **Step 5: Run — pass**

- [ ] **Step 6: Commit**

```bash
git add content_tool/models/outline.py tests/unit/test_outline_schema.py tests/fixtures/gemini_responses/outline_ok.json
git commit -m "feat: Outline Pydantic schema"
```

---

### Task 4: ORM models + migration for `outlines` + `fetched_articles`

**Files:**
- Modify: `content_tool/db/models.py`
- Create: `migrations/versions/0002_fetched_articles_and_outlines.py`

- [ ] **Step 1: Append to `content_tool/db/models.py`**

```python
from datetime import datetime
from uuid import UUID

from sqlalchemy import TIMESTAMP, ForeignKey, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column


class FetchedArticle(Base):
    __tablename__ = "fetched_articles"

    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"),
        primary_key=True,
    )
    fetched_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    wp_post_id: Mapped[int | None]
    wp_categories: Mapped[list | None] = mapped_column(JSONB)
    raw_html: Mapped[str | None] = mapped_column(String)
    markdown: Mapped[str] = mapped_column(String, nullable=False)


class OutlineRow(Base):
    __tablename__ = "outlines"

    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    edited_by_human: Mapped[bool] = mapped_column(default=False)
    human_edits: Mapped[dict | None] = mapped_column(JSONB)
```

- [ ] **Step 2: Create migration `migrations/versions/0002_fetched_articles_and_outlines.py`**

```python
"""fetched_articles + outlines

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-21
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"


def upgrade() -> None:
    op.create_table(
        "fetched_articles",
        sa.Column("run_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("fetched_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("wp_post_id", sa.Integer),
        sa.Column("wp_categories", postgresql.JSONB),
        sa.Column("raw_html", sa.String),
        sa.Column("markdown", sa.String, nullable=False),
        schema="content_tool",
    )
    op.create_table(
        "outlines",
        sa.Column("run_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.Column("edited_by_human", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("human_edits", postgresql.JSONB),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("outlines", schema="content_tool")
    op.drop_table("fetched_articles", schema="content_tool")
```

- [ ] **Step 3: Apply migration locally + commit**

```bash
alembic upgrade head
git add content_tool/db/models.py migrations/versions/0002_fetched_articles_and_outlines.py
git commit -m "feat(db): fetched_articles + outlines tables"
```

---

### Task 5: `fetch_article` node — WordPress REST adapter

**Files:**
- Create: `content_tool/agents/fetch_article.py`
- Create: `tests/fixtures/wp_responses/post_response.json`, `tests/fixtures/wp_responses/categories_response.json`, `tests/fixtures/wp_responses/shortlink_headers.json`
- Create: `tests/integration/test_fetch_article_node.py`

- [ ] **Step 1: Create fixtures**

`tests/fixtures/wp_responses/post_response.json`:
```json
{
  "id": 98785,
  "slug": "cancer-screening",
  "categories": [42, 7],
  "link": "https://www.bowtie.com.hk/blog/zh/cancer-screening/",
  "title": {"rendered": "大腸癌篩查指南"},
  "status": "publish",
  "author": 5,
  "modified_gmt": "2026-04-12T08:30:00",
  "content": {"rendered": "<h2>什麼是大腸癌？</h2><p>大腸癌是...</p>"}
}
```

`tests/fixtures/wp_responses/categories_response.json`:
```json
[
  {"id": 42, "name": "癌症", "slug": "cancer"},
  {"id": 7, "name": "醫療保險", "slug": "medical-insurance"}
]
```

- [ ] **Step 2: Write failing test — `tests/integration/test_fetch_article_node.py`**

```python
from uuid import uuid4

import pytest
import respx
from httpx import Response
from sqlalchemy import select

from content_tool.agents.fetch_article import fetch_article
from content_tool.db.models import FetchedArticle, Run


@pytest.mark.asyncio
async def test_fetch_article_resolves_via_shortlink_and_writes(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="fetching",
        article_url="https://www.bowtie.com.hk/blog/zh/cancer-screening/",
        topic="x", keywords=["x"], mode="auto", acf_adv_id=1, acf_widget_id=2,
        persona="bowtie-editor", today_date="2026-05-21",
    ))
    await db_session.commit()

    with respx.mock(assert_all_called=True) as router:
        # 1. Page resolution returns Link header with ?p=98785
        router.get("https://www.bowtie.com.hk/blog/zh/cancer-screening/").mock(
            return_value=Response(200, headers={
                "Link": "<https://www.bowtie.com.hk/blog/?p=98785>; rel=shortlink"
            }, text="ignored")
        )
        # 2. WP post fetch
        router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json={
                "id": 98785, "slug": "cancer-screening", "categories": [42, 7],
                "link": "https://www.bowtie.com.hk/blog/zh/cancer-screening/",
                "title": {"rendered": "大腸癌篩查指南"}, "status": "publish", "author": 5,
                "modified_gmt": "2026-04-12T08:30:00",
                "content": {"rendered": "<h2>什麼是大腸癌？</h2><p>大腸癌是...</p>"},
            })
        )
        # 3. Categories
        router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/categories").mock(
            return_value=Response(200, json=[
                {"id": 42, "name": "癌症", "slug": "cancer"},
                {"id": 7, "name": "醫療保險", "slug": "medical-insurance"},
            ])
        )

        result = await fetch_article(session=db_session, run_id=run_id, article_url=str(
            db_session.get(Run, run_id) and "https://www.bowtie.com.hk/blog/zh/cancer-screening/"
        ))

    assert result["wp_post_id"] == 98785
    assert "大腸癌" in result["markdown"]

    row = (await db_session.execute(select(FetchedArticle).where(FetchedArticle.run_id == run_id))).scalar_one()
    assert row.wp_post_id == 98785
    assert row.markdown is not None
    assert any(c["slug"] == "cancer" for c in row.wp_categories)
```

- [ ] **Step 3: Run — fails**

- [ ] **Step 4: Implement `content_tool/agents/fetch_article.py`**

```python
import re
from typing import Any
from uuid import UUID

import httpx
from markdownify import markdownify as md
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import FetchedArticle


_WP_BASE_DEFAULT = "https://www.bowtie.com.hk/blog/wp-json/wp/v2"
_SHORTLINK_RE = re.compile(r"[?&]p=(\d+)")


async def fetch_article(
    *,
    session: AsyncSession,
    run_id: UUID,
    article_url: str,
    wp_base: str = _WP_BASE_DEFAULT,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=15.0, follow_redirects=True)
    try:
        # Resolve to post id
        resolve = await client.get(article_url)
        link_header = resolve.headers.get("Link") or resolve.headers.get("link") or ""
        m = _SHORTLINK_RE.search(link_header)
        if not m:
            raise RuntimeError(f"Cannot resolve post id from {article_url}")
        post_id = int(m.group(1))

        # Fetch post
        post_resp = await client.get(f"{wp_base}/posts/{post_id}",
                                     params={"_fields": "id,slug,categories,link,title,status,author,modified_gmt,content"})
        post_resp.raise_for_status()
        post = post_resp.json()

        # Fetch categories
        cat_ids = post.get("categories", [])
        cats: list[dict[str, Any]] = []
        if cat_ids:
            cat_resp = await client.get(f"{wp_base}/categories",
                                        params={"include": ",".join(map(str, cat_ids)), "_fields": "id,name,slug"})
            cat_resp.raise_for_status()
            cats = cat_resp.json()

        html = post["content"]["rendered"]
        markdown = md(html, heading_style="ATX")

        session.add(FetchedArticle(
            run_id=run_id, wp_post_id=post_id, wp_categories=cats,
            raw_html=html, markdown=markdown,
        ))
        await session.commit()

        return {
            "wp_post_id": post_id,
            "wp_categories": cats,
            "raw_html": html,
            "markdown": markdown,
        }
    finally:
        if own_client:
            await client.aclose()
```

- [ ] **Step 5: Run — pass**

- [ ] **Step 6: Commit**

```bash
git add content_tool/agents/fetch_article.py tests/integration/test_fetch_article_node.py tests/fixtures/wp_responses/
git commit -m "feat: fetch_article node (WP REST + shortlink resolution + html→md)"
```

---

### Task 6: outline prompt + node

**Files:**
- Create: `prompts/outline.md`
- Create: `content_tool/agents/outline.py`
- Create: `tests/integration/test_outline_node.py`

- [ ] **Step 1: Create `prompts/outline.md`**

```markdown
你是香港繁體中文 SEO 內容規劃編輯。你的任務是接收 content gap analysis 與現有文章，產出 writer 將直接使用的 section-by-section 大綱。

今天是 {today_date}

你會收到：
- gap_analysis（完整 JSON）
- existing_article_markdown
- chosen_route（small_refresh 或 full_rewrite）
- acf_adv_id
- acf_widget_id

任務：
1. 將 gap_analysis.recommended_outline 細化成結構化 sections list。
2. 每個 section 必須標註 action：
   - keep（保留原有 wording 與內容）
   - update（保留 heading，內容需根據 gap 更新）
   - add（新加）
   - remove
   - reorder
3. small_refresh 路線：除非 gap_analysis 明確指出，否則 H2 wording 必須保留；新增 sections 不應多於 2 個。
4. full_rewrite 路線：可自由重組 H2 / H3 / 順序。
5. faq_section 必須對應 gap_analysis.update_plan.faq_to_add 與既有 FAQ 改動。
6. shortcode_positions：adv_panel 必須緊接首段（adv_panel_after_section_index = 0 通常合適），page_widget 必須在 FAQ 前（固定為 "faq"）。

輸出要求：
- 使用香港繁體中文
- sections.heading_level 只可為 2 或 3
- format_hint 必須符合 paragraph | bullet | numbered | table 之一
- 不要寫文章內容，只列 key_points
- 只輸出符合 schema 的 JSON
```

- [ ] **Step 2: Write failing test — `tests/integration/test_outline_node.py`**

```python
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.outline import run_outline
from content_tool.db.models import FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_outline_node_persists_and_returns(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="strategy",
        article_url="https://e.com", topic="大腸癌", keywords=["大腸癌"], mode="auto",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        today_date=date(2026, 5, 21), chosen_route="small_refresh",
    ))
    db_session.add(FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="# old article"))
    ga_payload = json.loads(Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8"))
    db_session.add(GapAnalysisRow(run_id=run_id, model="gemini-3.5-flash", thinking_level="high", payload=ga_payload))
    await db_session.commit()

    canned = json.loads(Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8"))
    gemini = FakeGeminiClient(canned_responses={"outline": canned})

    out = await run_outline(session=db_session, gemini=gemini, run_id=run_id, today=date(2026, 5, 21))

    assert out.h1.startswith("大腸癌")
    row = (await db_session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))).scalar_one()
    assert row.payload["h1"] == out.h1
    assert row.edited_by_human is False
```

- [ ] **Step 3: Run — fails**

- [ ] **Step 4: Implement `content_tool/agents/outline.py`**

```python
from datetime import date
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.outline import Outline


PROMPT_PATH = Path("prompts/outline.md")


def build_system_prompt(today: date) -> str:
    return PROMPT_PATH.read_text(encoding="utf-8").replace("{today_date}", today.isoformat())


def build_user_prompt(
    *,
    gap_analysis_payload: dict,
    existing_markdown: str,
    chosen_route: str,
    acf_adv_id: int,
    acf_widget_id: int,
) -> str:
    import json as _j
    return (
        f"chosen_route: {chosen_route}\n"
        f"acf_adv_id: {acf_adv_id}\n"
        f"acf_widget_id: {acf_widget_id}\n\n"
        f"# gap_analysis\n{_j.dumps(gap_analysis_payload, ensure_ascii=False)}\n\n"
        f"# existing_article_markdown\n{existing_markdown}"
    )


async def run_outline(
    *, session: AsyncSession, gemini: GeminiClient, run_id: UUID, today: date,
) -> Outline:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    fa = (await session.execute(select(FetchedArticle).where(FetchedArticle.run_id == run_id))).scalar_one()
    ga = (await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))).scalar_one()

    sys_prompt = build_system_prompt(today)
    user_prompt = build_user_prompt(
        gap_analysis_payload=ga.payload, existing_markdown=fa.markdown,
        chosen_route=run.chosen_route or "small_refresh",
        acf_adv_id=run.acf_adv_id, acf_widget_id=run.acf_widget_id,
    )

    result = await gemini.generate(
        agent="outline",
        system_prompt=sys_prompt,
        user_prompt=user_prompt,
        response_schema=Outline.model_json_schema(),
        tools=[],
    )
    outline = Outline.model_validate(result.parsed)

    session.add(OutlineRow(run_id=run_id, payload=outline.model_dump(), edited_by_human=False))
    await session.commit()
    return outline
```

- [ ] **Step 5: Run — pass**

- [ ] **Step 6: Commit**

```bash
git add prompts/outline.md content_tool/agents/outline.py tests/integration/test_outline_node.py
git commit -m "feat: outline node with structured section schema"
```

---

### Task 7: LangGraph Postgres checkpointer

**Files:**
- Create: `content_tool/graph/__init__.py`, `content_tool/graph/checkpointer.py`

- [ ] **Step 1: Create `content_tool/graph/__init__.py`** (empty)

- [ ] **Step 2: Create `content_tool/graph/checkpointer.py`**

```python
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool


@asynccontextmanager
async def make_checkpointer(postgres_url: str) -> AsyncIterator[AsyncPostgresSaver]:
    # LangGraph's checkpointer uses psycopg async, not SQLAlchemy.
    # postgres_url should be a libpq URL (postgres://...); strip SQLAlchemy's "+asyncpg" if present.
    libpq_url = postgres_url.replace("+asyncpg", "")
    async with AsyncConnectionPool(libpq_url, max_size=4, open=False) as pool:
        await pool.open()
        saver = AsyncPostgresSaver(pool)
        await saver.setup()
        yield saver
```

- [ ] **Step 3: Commit**

```bash
git add content_tool/graph/
git commit -m "feat: LangGraph Postgres checkpointer factory"
```

---

### Task 8: Strategy subgraph (gap_analysis → outline) with fetch_article above it

**Files:**
- Create: `content_tool/graph/strategy.py`
- Create: `tests/integration/test_strategy_subgraph_e2e.py`

- [ ] **Step 1: Implement `content_tool/graph/strategy.py`**

```python
from datetime import date
from typing import Any
from uuid import UUID

from langgraph.graph import END, START, StateGraph
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.agents.fetch_article import fetch_article
from content_tool.agents.gap_analysis import run_gap_analysis
from content_tool.agents.outline import run_outline
from content_tool.gemini.client import GeminiClient
from content_tool.models.state import ContentToolState


def build_strategy_graph(
    *,
    session_factory: async_sessionmaker,
    gemini: GeminiClient,
):
    async def n_fetch_article(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            result = await fetch_article(
                session=session,
                run_id=UUID(state["run_id"]),
                article_url=state["article_url"],
            )
        return {
            "existing_article_markdown": result["markdown"],
            "wp_post_id": result["wp_post_id"],
            "wp_categories": result["wp_categories"],
            "status": "strategy",
        }

    async def n_gap_analysis(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            ga = await run_gap_analysis(
                session=session, gemini=gemini,
                run_id=UUID(state["run_id"]),
                today=date.fromisoformat(state["today_date"]),
            )
        return {"gap_analysis": ga.model_dump(), "chosen_route": ga.chosen_route}

    async def n_outline(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            o = await run_outline(
                session=session, gemini=gemini,
                run_id=UUID(state["run_id"]),
                today=date.fromisoformat(state["today_date"]),
            )
        return {"outline": o.model_dump()}

    g = StateGraph(ContentToolState)
    g.add_node("fetch_article", n_fetch_article)
    g.add_node("gap_analysis", n_gap_analysis)
    g.add_node("outline", n_outline)
    g.add_edge(START, "fetch_article")
    g.add_edge("fetch_article", "gap_analysis")
    g.add_edge("gap_analysis", "outline")
    g.add_edge("outline", END)
    return g
```

- [ ] **Step 2: Write E2E test — `tests/integration/test_strategy_subgraph_e2e.py`**

```python
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
import respx
from httpx import Response

from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import OutlineRow, Run
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.strategy import build_strategy_graph
from sqlalchemy import select


@pytest.mark.asyncio
async def test_strategy_subgraph_end_to_end(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)

    # Seed run
    run_id = uuid4()
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="pending",
            article_url="https://www.bowtie.com.hk/blog/zh/cancer-screening/",
            topic="大腸癌", keywords=["大腸癌"], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 21),
        ))
        await s.commit()

    canned = {
        "gap_analysis": json.loads(Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")),
        "outline": json.loads(Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8")),
    }
    gemini = FakeGeminiClient(canned_responses=canned)

    with respx.mock(assert_all_called=True) as router:
        router.get("https://www.bowtie.com.hk/blog/zh/cancer-screening/").mock(
            return_value=Response(200, headers={"Link": "<https://www.bowtie.com.hk/blog/?p=98785>; rel=shortlink"}, text="x")
        )
        router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json={
                "id": 98785, "slug": "cancer-screening", "categories": [42],
                "link": "https://example.com", "title": {"rendered": "x"}, "status": "publish", "author": 5,
                "modified_gmt": "2026-04-12T08:30:00",
                "content": {"rendered": "<h2>大腸癌</h2><p>內容</p>"},
            })
        )
        router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/categories").mock(
            return_value=Response(200, json=[{"id": 42, "name": "癌症", "slug": "cancer"}])
        )

        async with make_checkpointer(postgres_url) as cp:
            graph = build_strategy_graph(session_factory=sf, gemini=gemini).compile(checkpointer=cp)
            config = {"configurable": {"thread_id": str(run_id)}}
            initial: dict = {
                "run_id": str(run_id),
                "article_url": "https://www.bowtie.com.hk/blog/zh/cancer-screening/",
                "topic": "大腸癌", "keywords": ["大腸癌"], "mode": "auto",
                "edit_note": None, "acf_adv_id": 1, "acf_widget_id": 2,
                "persona": "bowtie-editor", "topic_category": None,
                "today_date": "2026-05-21",
                "existing_article_markdown": None, "wp_post_id": None, "wp_categories": None,
                "gap_analysis": None, "outline": None, "chosen_route": None,
                "writer_output": None, "grounding_chunks": None, "citations": None,
                "render": None, "final_markup": None, "audit_findings": None, "iteration": 0,
                "hitl_1_decision": None, "hitl_1_edits": None,
                "hitl_2_decision": None, "hitl_2_notes": None,
                "status": "pending", "error": None,
            }
            final = await graph.ainvoke(initial, config=config)

    assert final["chosen_route"] == "small_refresh"
    assert final["outline"]["h1"].startswith("大腸癌")

    async with sf() as s:
        row = (await s.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))).scalar_one()
        assert row.payload["h1"] == final["outline"]["h1"]

    await engine.dispose()
```

- [ ] **Step 3: Run — pass**

Run: `pytest tests/integration/test_strategy_subgraph_e2e.py -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add content_tool/graph/strategy.py tests/integration/test_strategy_subgraph_e2e.py
git commit -m "feat: Strategy subgraph (fetch → gap_analysis → outline)"
```

---

### Task 9: Root graph with HITL_1 interrupt

**Files:**
- Create: `content_tool/graph/root.py`

- [ ] **Step 1: Implement `content_tool/graph/root.py`**

```python
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.gemini.client import GeminiClient
from content_tool.graph.strategy import build_strategy_graph
from content_tool.models.state import ContentToolState


def build_root_graph(
    *,
    session_factory: async_sessionmaker,
    gemini: GeminiClient,
    checkpointer: AsyncPostgresSaver,
):
    # Strategy is exposed as a subgraph node
    strategy = build_strategy_graph(session_factory=session_factory, gemini=gemini).compile()

    root = StateGraph(ContentToolState)
    root.add_node("strategy", strategy)
    # Production is added in Plan 3; for now we END after HITL_1 ack.
    async def n_hitl_2_placeholder(state: ContentToolState) -> dict:
        return {"status": "hitl_2"}

    root.add_node("post_hitl_1", n_hitl_2_placeholder)

    root.add_edge(START, "strategy")
    root.add_edge("strategy", "post_hitl_1")
    root.add_edge("post_hitl_1", END)

    # HITL_1 interrupts BEFORE post_hitl_1 (i.e. after strategy completes).
    return root.compile(checkpointer=checkpointer, interrupt_before=["post_hitl_1"])
```

- [ ] **Step 2: Commit**

```bash
git add content_tool/graph/root.py
git commit -m "feat: root graph with HITL_1 interrupt (post-strategy)"
```

---

### Task 10: API schemas + POST /runs

**Files:**
- Create: `content_tool/api/schemas.py`
- Modify: `content_tool/api/routes/runs.py`

- [ ] **Step 1: Create `content_tool/api/schemas.py`**

```python
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class CreateRunRequest(BaseModel):
    article_url: str
    topic: str
    keywords: list[str]
    mode: Literal["auto", "small_refresh", "full_rewrite"] = "auto"
    edit_note: str | None = None
    acf_adv_id: int
    acf_widget_id: int
    persona: str = "bowtie-editor"
    topic_category: str | None = None
    editor_email: str = Field(description="Identifies who triggered the run")


class CreateRunResponse(BaseModel):
    run_id: UUID
    status: str
    created_at: datetime


class ResumeRequest(BaseModel):
    decision: Literal["approve", "edit_outline", "override_route", "cancel"]
    edited_outline: dict | None = None
    new_route: Literal["small_refresh", "full_rewrite"] | None = None
    notes: str | None = None
```

- [ ] **Step 2: Replace `content_tool/api/routes/runs.py`**

```python
from datetime import date
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select

from content_tool.api.schemas import CreateRunRequest, CreateRunResponse
from content_tool.db.models import Run

router = APIRouter(prefix="/runs", tags=["runs"])


def get_session_factory(request: Request):
    return request.app.state.session_factory


def get_runner(request: Request):
    return request.app.state.run_executor


@router.post("", response_model=CreateRunResponse)
async def create_run(
    payload: CreateRunRequest,
    sf=Depends(get_session_factory),
    runner=Depends(get_runner),
) -> CreateRunResponse:
    run_id = uuid4()
    async with sf() as session:
        row = Run(
            run_id=run_id, created_by=payload.editor_email, status="pending",
            article_url=payload.article_url, topic=payload.topic, keywords=payload.keywords,
            mode=payload.mode, edit_note=payload.edit_note,
            acf_adv_id=payload.acf_adv_id, acf_widget_id=payload.acf_widget_id,
            persona=payload.persona, topic_category=payload.topic_category,
            today_date=date.today(),
        )
        session.add(row)
        await session.commit()

    # Fire and forget: spawn graph execution
    await runner.start(run_id)
    return CreateRunResponse(run_id=run_id, status="pending", created_at=row.created_at if row.created_at else __import__("datetime").datetime.utcnow())


@router.get("/{run_id}")
async def get_run(run_id: UUID, sf=Depends(get_session_factory)) -> dict:
    async with sf() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "run not found")
        return {
            "run_id": str(row.run_id), "status": row.status, "topic": row.topic,
            "article_url": row.article_url, "mode": row.mode,
            "chosen_route": row.chosen_route, "iteration_count": row.iteration_count,
        }
```

- [ ] **Step 3: Commit**

```bash
git add content_tool/api/schemas.py content_tool/api/routes/runs.py
git commit -m "feat(api): POST /runs + GET /runs/{id}"
```

---

### Task 11: Background run executor with SSE event bus

**Files:**
- Create: `content_tool/api/sse.py`
- Modify: `content_tool/api/main.py`

- [ ] **Step 1: Create `content_tool/api/sse.py`**

```python
import asyncio
import json
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.gemini.client import GeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.root import build_root_graph


class RunExecutor:
    """Owns background tasks per run; multicasts LangGraph events to SSE subscribers."""

    def __init__(self, *, postgres_url: str, session_factory: async_sessionmaker, gemini: GeminiClient) -> None:
        self._postgres_url = postgres_url
        self._sf = session_factory
        self._gemini = gemini
        self._subscribers: dict[UUID, list[asyncio.Queue[str]]] = {}
        self._tasks: dict[UUID, asyncio.Task] = {}

    def subscribe(self, run_id: UUID) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue()
        self._subscribers.setdefault(run_id, []).append(q)
        return q

    def unsubscribe(self, run_id: UUID, q: asyncio.Queue[str]) -> None:
        if run_id in self._subscribers and q in self._subscribers[run_id]:
            self._subscribers[run_id].remove(q)

    async def _emit(self, run_id: UUID, event: str, payload: dict[str, Any]) -> None:
        data = json.dumps({
            "event": event, "run_id": str(run_id),
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "payload": payload,
        }, ensure_ascii=False)
        for q in self._subscribers.get(run_id, []):
            await q.put(data)

    async def start(self, run_id: UUID) -> None:
        self._tasks[run_id] = asyncio.create_task(self._run(run_id))

    async def resume(self, run_id: UUID, update: dict[str, Any]) -> None:
        self._tasks[run_id] = asyncio.create_task(self._run(run_id, resume=True, update=update))

    async def _run(self, run_id: UUID, *, resume: bool = False, update: dict | None = None) -> None:
        try:
            async with make_checkpointer(self._postgres_url) as cp:
                graph = build_root_graph(session_factory=self._sf, gemini=self._gemini, checkpointer=cp)
                config = {"configurable": {"thread_id": str(run_id)}}

                if resume:
                    if update:
                        await graph.aupdate_state(config, update)
                    inputs = None
                else:
                    inputs = await _build_initial_state(self._sf, run_id)

                async for chunk in graph.astream(inputs, config=config, stream_mode="updates"):
                    for node_name, _ in chunk.items():
                        await self._emit(run_id, f"{node_name}.done", {})

                state = await graph.aget_state(config)
                if state.next:  # interrupted
                    await self._emit(run_id, "hitl.interrupted", {"next": list(state.next)})
                else:
                    await self._emit(run_id, "graph.completed", {})
        except Exception as e:  # noqa: BLE001
            await self._emit(run_id, "graph.error", {"message": str(e)})


async def _build_initial_state(sf, run_id: UUID) -> dict[str, Any]:
    from sqlalchemy import select
    from content_tool.db.models import Run

    async with sf() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        return {
            "run_id": str(row.run_id), "article_url": row.article_url, "topic": row.topic,
            "keywords": row.keywords, "mode": row.mode, "edit_note": row.edit_note,
            "acf_adv_id": row.acf_adv_id, "acf_widget_id": row.acf_widget_id,
            "persona": row.persona, "topic_category": row.topic_category,
            "today_date": row.today_date.isoformat(),
            "existing_article_markdown": None, "wp_post_id": None, "wp_categories": None,
            "gap_analysis": None, "outline": None, "chosen_route": None,
            "writer_output": None, "grounding_chunks": None, "citations": None,
            "render": None, "final_markup": None, "audit_findings": None, "iteration": 0,
            "hitl_1_decision": None, "hitl_1_edits": None,
            "hitl_2_decision": None, "hitl_2_notes": None,
            "status": "pending", "error": None,
        }


async def sse_stream(executor: RunExecutor, run_id: UUID) -> AsyncIterator[dict[str, str]]:
    q = executor.subscribe(run_id)
    try:
        while True:
            data = await q.get()
            yield {"event": "message", "data": data}
    finally:
        executor.unsubscribe(run_id, q)
```

- [ ] **Step 2: Wire executor in `content_tool/api/main.py`**

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI

from content_tool.api.routes.runs import router as runs_router
from content_tool.api.sse import RunExecutor
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.client import RealGeminiClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    gemini = RealGeminiClient(
        api_key=settings.gemini_api_key, model=settings.gemini_model,
        thinking_level=settings.gemini_thinking_level,
    )
    executor = RunExecutor(postgres_url=settings.postgres_url, session_factory=sf, gemini=gemini)
    app.state.session_factory = sf
    app.state.run_executor = executor
    try:
        yield
    finally:
        await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="Bowtie AI Content Tool", version="0.1.0", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(runs_router)
    return app


app = create_app()
```

- [ ] **Step 3: Commit**

```bash
git add content_tool/api/sse.py content_tool/api/main.py
git commit -m "feat(api): RunExecutor + LangGraph event multicast over SSE"
```

---

### Task 12: SSE endpoint + resume endpoint

**Files:**
- Modify: `content_tool/api/routes/runs.py`

- [ ] **Step 1: Append routes to `content_tool/api/routes/runs.py`**

```python
from fastapi import Depends
from sse_starlette.sse import EventSourceResponse

from content_tool.api.schemas import ResumeRequest
from content_tool.api.sse import sse_stream


@router.get("/{run_id}/events")
async def events(run_id: UUID, runner=Depends(get_runner)):
    return EventSourceResponse(sse_stream(runner, run_id))


@router.post("/{run_id}/resume")
async def resume_run(
    run_id: UUID, payload: ResumeRequest,
    sf=Depends(get_session_factory), runner=Depends(get_runner),
) -> dict:
    state_update: dict = {"hitl_1_decision": payload.decision}
    if payload.decision == "edit_outline" and payload.edited_outline:
        state_update["outline"] = payload.edited_outline
        # Also persist to outlines.human_edits
        from sqlalchemy import update
        from content_tool.db.models import OutlineRow
        async with sf() as session:
            await session.execute(
                update(OutlineRow).where(OutlineRow.run_id == run_id)
                .values(edited_by_human=True, human_edits=payload.edited_outline)
            )
            await session.commit()
    if payload.decision == "override_route" and payload.new_route:
        state_update["chosen_route"] = payload.new_route

    await runner.resume(run_id, state_update)
    return {"ok": True}
```

- [ ] **Step 2: Commit**

```bash
git add content_tool/api/routes/runs.py
git commit -m "feat(api): SSE events + HITL_1 resume endpoint"
```

---

### Task 13: API integration test — POST /runs → SSE → resume → final state

**Files:**
- Create: `tests/integration/test_api_runs.py`

- [ ] **Step 1: Write the test**

```python
import asyncio
import json
from datetime import date
from pathlib import Path
from uuid import UUID

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response

from content_tool.api.main import create_app
from content_tool.api.sse import RunExecutor
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_create_run_then_resume(postgres_url, monkeypatch):
    monkeypatch.setenv("POSTGRES_URL", postgres_url)
    monkeypatch.setenv("GEMINI_API_KEY", "fake")

    app = create_app()

    # Override gemini + executor with fakes during lifespan
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        engine = make_engine(postgres_url)
        sf = make_session_factory(engine)
        canned = {
            "gap_analysis": json.loads(Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")),
            "outline": json.loads(Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8")),
        }
        fake = FakeGeminiClient(canned_responses=canned)
        app.state.session_factory = sf
        app.state.run_executor = RunExecutor(postgres_url=postgres_url, session_factory=sf, gemini=fake)

        with respx.mock(assert_all_called=False) as router:
            router.get("https://www.bowtie.com.hk/blog/zh/cancer-screening/").mock(
                return_value=Response(200, headers={"Link": "<https://www.bowtie.com.hk/blog/?p=98785>; rel=shortlink"}, text="x")
            )
            router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/posts/98785").mock(
                return_value=Response(200, json={
                    "id": 98785, "slug": "x", "categories": [42],
                    "link": "x", "title": {"rendered": "x"}, "status": "publish", "author": 5,
                    "modified_gmt": "2026-04-12T08:30:00",
                    "content": {"rendered": "<p>x</p>"},
                })
            )
            router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/categories").mock(
                return_value=Response(200, json=[{"id": 42, "name": "x", "slug": "x"}])
            )

            create_resp = await ac.post("/runs", json={
                "article_url": "https://www.bowtie.com.hk/blog/zh/cancer-screening/",
                "topic": "大腸癌", "keywords": ["大腸癌"], "mode": "auto",
                "acf_adv_id": 1, "acf_widget_id": 2,
                "persona": "bowtie-editor", "editor_email": "e@x.com",
            })
            assert create_resp.status_code == 200
            run_id = UUID(create_resp.json()["run_id"])

            # Give the background task time to run and interrupt
            await asyncio.sleep(2.0)

            # Resume with approve
            resume_resp = await ac.post(f"/runs/{run_id}/resume", json={"decision": "approve"})
            assert resume_resp.status_code == 200

            # Eventually the run ends; check chosen_route
            await asyncio.sleep(1.0)
            state_resp = await ac.get(f"/runs/{run_id}")
            assert state_resp.json()["chosen_route"] == "small_refresh"

        await engine.dispose()
```

- [ ] **Step 2: Run — pass**

Run: `pytest tests/integration/test_api_runs.py -v -s`
Expected: PASS

(Note: the `asyncio.sleep` calls are coarse — in production the UI watches SSE events; the test just confirms wiring end-to-end. If flaky, increase sleeps to 3.0s.)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/test_api_runs.py
git commit -m "test(api): POST /runs → SSE interrupt → resume → final state"
```

---

### Task 14: Manual smoke test against real Gemini

(Not committed — documented in `README.md`.)

- [ ] **Step 1: Append to `README.md`**

```markdown
## Manual smoke test (Plan 2)

```bash
# 1. Start Postgres + apply migrations
docker run -d --name content_tool_pg -p 5432:5432 \
  -e POSTGRES_USER=content_tool -e POSTGRES_PASSWORD=content_tool -e POSTGRES_DB=content_tool postgres:16
export POSTGRES_URL=postgresql+asyncpg://content_tool:content_tool@localhost:5432/content_tool
export GEMINI_API_KEY=<your-key>
alembic upgrade head

# 2. Start the API
uvicorn content_tool.api.main:app --reload --port 8000

# 3. Trigger a run
curl -X POST localhost:8000/runs \
  -H 'content-type: application/json' \
  -d '{"article_url":"https://www.bowtie.com.hk/blog/zh/<some-real-slug>/",
        "topic":"...","keywords":["..."],
        "acf_adv_id":1,"acf_widget_id":2,
        "editor_email":"you@bowtie.com"}'

# 4. Watch events
curl -N localhost:8000/runs/<run_id>/events

# 5. After HITL_1 interrupt, approve:
curl -X POST localhost:8000/runs/<run_id>/resume \
  -H 'content-type: application/json' -d '{"decision":"approve"}'
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: Plan 2 manual smoke test instructions"
```

---

## Self-review checklist

| Concern | Covered |
|---|---|
| LangGraph deps | Task 1 |
| ContentToolState | Task 2 |
| Outline schema | Task 3 |
| DB migrations | Task 4 |
| fetch_article (WP REST) | Task 5 |
| outline node | Task 6 |
| Postgres checkpointer | Task 7 |
| Strategy subgraph composition | Task 8 |
| Root graph + HITL_1 interrupt | Task 9 |
| POST /runs + GET /runs/{id} | Task 10 |
| Background executor + SSE | Tasks 11-12 |
| End-to-end API test | Task 13 |
| Manual smoke test docs | Task 14 |

After Plan 2 ships: the Strategy subgraph runs end-to-end via the API, with HITL_1 interrupt and resume working. No UI yet — Plan 4. No Production subgraph yet — Plan 3.
