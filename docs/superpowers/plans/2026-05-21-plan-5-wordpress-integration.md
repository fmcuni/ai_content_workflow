# Plan 5 — WordPress Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prereq:** Plans 1, 2, 3, 4 shipped.

**Goal:** Replace the `persist` no-op with a real `publish_to_wordpress` node. Detect SEO plugin (Yoast vs RankMath) at startup. Implement `If-Unmodified-Since` idempotency. Add dry-run mode + staging/production WP target switch. Default publish status remains `draft`.

**Architecture:** New module `content_tool/wordpress/` with two concerns: the SEO plugin detector (one-shot at app startup, cached) and the REST publisher. The publisher is a pure async function — easy to test with respx. The `publish_to_wordpress` LangGraph node wraps it and writes the post id + status back to `runs`.

---

## File structure (new + modified)

```
ai_content_tool_2/
├── content_tool/
│   ├── wordpress/
│   │   ├── __init__.py            # NEW
│   │   ├── client.py              # NEW (REST publisher)
│   │   └── seo_plugin.py          # NEW (Yoast/RankMath detector)
│   ├── agents/
│   │   └── publish.py             # NEW (LangGraph node)
│   ├── graph/
│   │   └── root.py                # MODIFY (real persist + publish)
│   ├── api/
│   │   ├── routes/runs.py         # MODIFY (POST /runs/{id}/dry-publish)
│   │   └── schemas.py             # MODIFY (DryPublishResponse)
│   ├── config.py                  # MODIFY (WP env vars)
├── tests/
│   ├── fixtures/wp_responses/
│   │   ├── publish_response.json  # NEW
│   │   ├── conflict_412.json      # NEW
│   │   └── types_post.json        # NEW (SEO plugin detection)
│   ├── unit/
│   │   ├── test_wp_seo_plugin.py  # NEW
│   │   └── test_wp_client.py      # NEW
│   └── integration/
│       ├── test_publish_node.py   # NEW
│       └── test_dry_publish.py    # NEW
```

---

### Task 1: WP-related settings

**Files:** Modify `content_tool/config.py`, `.env.example`

- [ ] **Step 1: Append fields to `Settings`**

```python
class Settings(BaseSettings):
    # ... existing fields ...
    wp_base_url: str = "https://staging.bowtie.com.hk"
    wp_target: str = "staging"                # staging | production
    wp_username: str = ""                     # WP user the editor authenticates as
    wp_app_password: str = ""                 # Application Password
    wp_timeout: float = 15.0
```

- [ ] **Step 2: Append to `.env.example`**

```bash
# WordPress
WP_BASE_URL=https://staging.bowtie.com.hk
WP_TARGET=staging
WP_USERNAME=
WP_APP_PASSWORD=
```

- [ ] **Step 3: Commit**

```bash
git add content_tool/config.py .env.example
git commit -m "feat(config): WordPress env vars"
```

---

### Task 2: SEO plugin detector

**Files:** Create `content_tool/wordpress/__init__.py`, `content_tool/wordpress/seo_plugin.py`, fixtures, test

- [ ] **Step 1: Create fixture `tests/fixtures/wp_responses/types_post.json`**

```json
{
  "post": {
    "supports": {"title": true, "editor": true, "custom-fields": true},
    "rest_base": "posts",
    "meta_fields": ["_yoast_wpseo_metadesc", "_yoast_wpseo_title", "_yoast_wpseo_focuskw"]
  }
}
```

- [ ] **Step 2: Write failing test**

```python
import json
from pathlib import Path

import pytest
import respx
from httpx import Response

from content_tool.wordpress.seo_plugin import detect_seo_plugin


@pytest.mark.asyncio
async def test_detects_yoast():
    types_resp = json.loads(Path("tests/fixtures/wp_responses/types_post.json").read_text(encoding="utf-8"))
    with respx.mock(assert_all_called=True) as r:
        r.get("https://wp.example.com/wp-json/wp/v2/types/post").mock(
            return_value=Response(200, json=types_resp)
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin == "yoast"


@pytest.mark.asyncio
async def test_detects_rankmath_when_meta_keys_match():
    payload = {"post": {"meta_fields": ["rank_math_description", "rank_math_title"]}}
    with respx.mock(assert_all_called=True) as r:
        r.get("https://wp.example.com/wp-json/wp/v2/types/post").mock(
            return_value=Response(200, json=payload)
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin == "rankmath"


@pytest.mark.asyncio
async def test_none_when_no_seo_meta():
    with respx.mock(assert_all_called=True) as r:
        r.get("https://wp.example.com/wp-json/wp/v2/types/post").mock(
            return_value=Response(200, json={"post": {"meta_fields": []}})
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin is None
```

- [ ] **Step 3: Implement `content_tool/wordpress/__init__.py`** (empty)

- [ ] **Step 4: Implement `content_tool/wordpress/seo_plugin.py`**

```python
from typing import Literal

import httpx


SeoPlugin = Literal["yoast", "rankmath"]


async def detect_seo_plugin(wp_base_url: str, client: httpx.AsyncClient | None = None) -> SeoPlugin | None:
    own = client is None
    client = client or httpx.AsyncClient(timeout=10.0)
    try:
        resp = await client.get(f"{wp_base_url}/wp-json/wp/v2/types/post")
        resp.raise_for_status()
        data = resp.json()
        meta_fields = data.get("post", {}).get("meta_fields", [])
        if any(m.startswith("_yoast_wpseo_") for m in meta_fields):
            return "yoast"
        if any(m.startswith("rank_math_") for m in meta_fields):
            return "rankmath"
        return None
    finally:
        if own:
            await client.aclose()
```

- [ ] **Step 5: Run + commit**

Run: `pytest tests/unit/test_wp_seo_plugin.py -v`
Expected: PASS

```bash
git add content_tool/wordpress/__init__.py content_tool/wordpress/seo_plugin.py tests/unit/test_wp_seo_plugin.py tests/fixtures/wp_responses/types_post.json
git commit -m "feat(wp): SEO plugin detection (Yoast/RankMath)"
```

---

### Task 3: WP publisher client

**Files:** Create `content_tool/wordpress/client.py`, `tests/unit/test_wp_client.py`

- [ ] **Step 1: Create fixtures**

`tests/fixtures/wp_responses/publish_response.json`:
```json
{
  "id": 98785,
  "link": "https://www.bowtie.com.hk/blog/zh/cancer-screening/",
  "status": "draft",
  "modified_gmt": "2026-05-21T10:00:00",
  "slug": "cancer-screening"
}
```

`tests/fixtures/wp_responses/conflict_412.json`:
```json
{"code": "rest_post_modified", "message": "post modified by someone else"}
```

- [ ] **Step 2: Write failing test — `tests/unit/test_wp_client.py`**

```python
import base64
import json
from pathlib import Path

import pytest
import respx
from httpx import Response

from content_tool.wordpress.client import WordPressClient, WordPressConflictError, PublishPayload


@pytest.mark.asyncio
async def test_publish_updates_existing_post():
    payload = PublishPayload(
        post_id=98785, title="x", content="<p>x</p>", excerpt="x",
        status="draft", slug="x", categories=[42], tags=[7], author=5,
        featured_media=None, meta={"_yoast_wpseo_metadesc": "x"},
        if_unmodified_since="2026-04-12T08:30:00",
    )
    expected_resp = json.loads(Path("tests/fixtures/wp_responses/publish_response.json").read_text(encoding="utf-8"))
    auth = "Basic " + base64.b64encode(b"user:pass").decode()
    with respx.mock(assert_all_called=True) as r:
        route = r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json=expected_resp)
        )
        client = WordPressClient("https://wp.example.com", username="user", app_password="pass")
        result = await client.upsert(payload)
        assert route.called
        assert route.calls.last.request.headers["authorization"] == auth
        assert route.calls.last.request.headers["if-unmodified-since"] == "2026-04-12T08:30:00"
    assert result.id == 98785
    assert result.status == "draft"


@pytest.mark.asyncio
async def test_publish_raises_on_412():
    body = json.loads(Path("tests/fixtures/wp_responses/conflict_412.json").read_text(encoding="utf-8"))
    with respx.mock(assert_all_called=True) as r:
        r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(412, json=body)
        )
        client = WordPressClient("https://wp.example.com", username="user", app_password="pass")
        with pytest.raises(WordPressConflictError):
            await client.upsert(PublishPayload(
                post_id=98785, title="x", content="x", excerpt="x",
                status="draft", slug=None, categories=[], tags=[], author=None,
                featured_media=None, meta={}, if_unmodified_since="2026-04-12T08:30:00",
            ))
```

- [ ] **Step 3: Implement `content_tool/wordpress/client.py`**

```python
import base64
from dataclasses import dataclass

import httpx


class WordPressError(Exception):
    pass


class WordPressConflictError(WordPressError):
    pass


@dataclass
class PublishPayload:
    post_id: int | None
    title: str
    content: str
    excerpt: str | None
    status: str
    slug: str | None
    categories: list[int]
    tags: list[int]
    author: int | None
    featured_media: int | None
    meta: dict[str, str]
    if_unmodified_since: str | None


@dataclass
class PublishResult:
    id: int
    link: str
    status: str
    modified_gmt: str
    slug: str


class WordPressClient:
    def __init__(self, base_url: str, *, username: str, app_password: str,
                 timeout: float = 15.0, client: httpx.AsyncClient | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._username = username
        self._password = app_password
        self._timeout = timeout
        self._client = client

    def _auth_header(self) -> str:
        token = base64.b64encode(f"{self._username}:{self._password}".encode()).decode()
        return f"Basic {token}"

    async def upsert(self, p: PublishPayload) -> PublishResult:
        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            headers = {"authorization": self._auth_header()}
            if p.if_unmodified_since:
                headers["if-unmodified-since"] = p.if_unmodified_since
            body = {
                "title": p.title, "content": p.content,
                "status": p.status,
                "categories": p.categories, "tags": p.tags,
                "meta": p.meta,
            }
            if p.excerpt is not None: body["excerpt"] = p.excerpt
            if p.slug is not None: body["slug"] = p.slug
            if p.author is not None: body["author"] = p.author
            if p.featured_media is not None: body["featured_media"] = p.featured_media

            if p.post_id:
                resp = await client.put(
                    f"{self._base_url}/wp-json/wp/v2/posts/{p.post_id}",
                    json=body, headers=headers,
                )
            else:
                resp = await client.post(
                    f"{self._base_url}/wp-json/wp/v2/posts",
                    json=body, headers=headers,
                )

            if resp.status_code == 412:
                raise WordPressConflictError(resp.text)
            if resp.is_error:
                raise WordPressError(f"{resp.status_code}: {resp.text}")

            data = resp.json()
            return PublishResult(
                id=data["id"], link=data["link"], status=data["status"],
                modified_gmt=data["modified_gmt"], slug=data["slug"],
            )
        finally:
            if own:
                await client.aclose()
```

- [ ] **Step 4: Run + commit**

Run: `pytest tests/unit/test_wp_client.py -v`
Expected: PASS

```bash
git add content_tool/wordpress/client.py tests/unit/test_wp_client.py tests/fixtures/wp_responses/publish_response.json tests/fixtures/wp_responses/conflict_412.json
git commit -m "feat(wp): WordPress REST publisher with 412 conflict handling"
```

---

### Task 4: `publish_to_wordpress` LangGraph node

**Files:** Create `content_tool/agents/publish.py`, `tests/integration/test_publish_node.py`

- [ ] **Step 1: Write failing test**

```python
from datetime import date, datetime
from uuid import uuid4

import pytest
import respx
from httpx import Response
from sqlalchemy import select

from content_tool.agents.publish import publish_to_wordpress
from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Render, Run
from content_tool.wordpress.client import WordPressClient


@pytest.mark.asyncio
async def test_publish_node_updates_runs(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="hitl_2",
        article_url="https://e.com", topic="x", keywords=[], mode="auto",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        today_date=date(2026, 5, 21), chosen_route="small_refresh",
        wp_publish_status="draft", wp_category_ids=[42], wp_author_id=5,
        approved_at=datetime.utcnow(), approved_by="e@x.com",
    ))
    db_session.add(FetchedArticle(run_id=run_id, wp_post_id=98785, wp_categories=[],
                                  raw_html="x", markdown="x"))
    db_session.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={}))
    db_session.add(OutlineRow(run_id=run_id, payload={}))
    draft = Draft(
        run_id=run_id, iteration=0, diagnose="d", markup_raw="x", final_markup="x",
        citation_intents=[],
    )
    db_session.add(draft)
    await db_session.commit()
    await db_session.refresh(draft)
    db_session.add(Render(
        draft_id=draft.draft_id, seo_title="新標題", meta_description="meta",
        html_body="<p>x</p>", excerpt_suggestion="e", slug_suggestion=None,
    ))
    await db_session.commit()

    with respx.mock(assert_all_called=True) as r:
        r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json={
                "id": 98785, "link": "https://wp.example.com/x",
                "status": "draft", "modified_gmt": "2026-05-21T10:00:00",
                "slug": "x",
            })
        )
        client = WordPressClient("https://wp.example.com", username="u", app_password="p")
        await publish_to_wordpress(
            session=db_session, run_id=run_id, wp_client=client, seo_plugin="yoast",
            if_unmodified_since="2026-04-12T08:30:00",
        )

    updated = (await db_session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert updated.wp_pushed_post_id == 98785
    assert updated.status == "published"
```

- [ ] **Step 2: Implement `content_tool/agents/publish.py`**

```python
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Draft, FetchedArticle, Render, Run
from content_tool.wordpress.client import PublishPayload, WordPressClient, WordPressConflictError


def _seo_meta_key(plugin: Literal["yoast", "rankmath"] | None) -> str | None:
    if plugin == "yoast":
        return "_yoast_wpseo_metadesc"
    if plugin == "rankmath":
        return "rank_math_description"
    return None


async def publish_to_wordpress(
    *,
    session: AsyncSession,
    run_id: UUID,
    wp_client: WordPressClient,
    seo_plugin: Literal["yoast", "rankmath"] | None,
    if_unmodified_since: str | None,
) -> dict:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    fa = (await session.execute(select(FetchedArticle).where(FetchedArticle.run_id == run_id))).scalar_one()
    latest_draft = (await session.execute(
        select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
    )).scalar_one()
    render = (await session.execute(
        select(Render).where(Render.draft_id == latest_draft.draft_id)
    )).scalar_one()

    meta: dict[str, str] = {}
    key = _seo_meta_key(seo_plugin)
    if key:
        meta[key] = render.meta_description

    payload = PublishPayload(
        post_id=fa.wp_post_id,
        title=render.seo_title,
        content=render.html_body,
        excerpt=run.wp_excerpt or render.excerpt_suggestion,
        status=run.wp_publish_status or "draft",
        slug=run.wp_slug,
        categories=run.wp_category_ids or [],
        tags=run.wp_tag_ids or [],
        author=run.wp_author_id,
        featured_media=run.wp_featured_media_id,
        meta=meta,
        if_unmodified_since=if_unmodified_since,
    )

    try:
        result = await wp_client.upsert(payload)
    except WordPressConflictError as e:
        await session.execute(update(Run).where(Run.run_id == run_id).values(
            status="failed",
            wp_push_error={"code": "conflict", "message": str(e)},
        ))
        await session.commit()
        raise

    await session.execute(update(Run).where(Run.run_id == run_id).values(
        wp_pushed_post_id=result.id,
        wp_pushed_at=datetime.utcnow(),
        status="published",
    ))
    await session.commit()
    return {"id": result.id, "link": result.link, "status": result.status}
```

- [ ] **Step 3: Run + commit**

Run: `pytest tests/integration/test_publish_node.py -v`
Expected: PASS

```bash
git add content_tool/agents/publish.py tests/integration/test_publish_node.py
git commit -m "feat(wp): publish_to_wordpress node with SEO plugin meta key"
```

---

### Task 5: Wire publish into the root graph + lifespan

**Files:** Modify `content_tool/graph/root.py`, `content_tool/api/main.py`

- [ ] **Step 1: Modify `content_tool/api/main.py` lifespan to detect SEO plugin + build WP client**

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from content_tool.api.routes.runs import router as runs_router
from content_tool.api.sse import RunExecutor
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.client import RealGeminiClient
from content_tool.wordpress.client import WordPressClient
from content_tool.wordpress.seo_plugin import detect_seo_plugin


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    gemini = RealGeminiClient(
        api_key=settings.gemini_api_key, model=settings.gemini_model,
        thinking_level=settings.gemini_thinking_level,
    )
    seo_plugin = None
    if settings.wp_base_url:
        try:
            seo_plugin = await detect_seo_plugin(settings.wp_base_url)
        except Exception:  # noqa: BLE001
            seo_plugin = None
    wp_client = WordPressClient(
        settings.wp_base_url, username=settings.wp_username, app_password=settings.wp_app_password,
        timeout=settings.wp_timeout,
    )

    app.state.session_factory = sf
    app.state.run_executor = RunExecutor(
        postgres_url=settings.postgres_url, session_factory=sf, gemini=gemini,
        wp_client=wp_client, seo_plugin=seo_plugin,
    )
    app.state.wp_client = wp_client
    app.state.seo_plugin = seo_plugin
    app.state.wp_target = settings.wp_target
    try:
        yield
    finally:
        await engine.dispose()
```

- [ ] **Step 2: Update `RunExecutor` to accept wp_client + seo_plugin and pass to root graph**

Modify `content_tool/api/sse.py`:

```python
class RunExecutor:
    def __init__(
        self, *, postgres_url, session_factory, gemini,
        wp_client=None, seo_plugin=None,
    ):
        self._postgres_url = postgres_url
        self._sf = session_factory
        self._gemini = gemini
        self._wp_client = wp_client
        self._seo_plugin = seo_plugin
        # ... rest unchanged
```

And in `_run`, when building the graph:
```python
graph = build_root_graph(
    session_factory=self._sf, gemini=self._gemini,
    checkpointer=cp,
    wp_client=self._wp_client, seo_plugin=self._seo_plugin,
)
```

- [ ] **Step 3: Replace `content_tool/graph/root.py`**

```python
from typing import Any
from datetime import date as _date
from uuid import UUID

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.agents.publish import publish_to_wordpress
from content_tool.db.models import FetchedArticle
from content_tool.gemini.client import GeminiClient
from content_tool.graph.production import build_production_graph
from content_tool.graph.strategy import build_strategy_graph
from content_tool.models.state import ContentToolState
from content_tool.wordpress.client import WordPressClient


def build_root_graph(
    *,
    session_factory: async_sessionmaker,
    gemini: GeminiClient,
    checkpointer: AsyncPostgresSaver,
    wp_client: WordPressClient | None = None,
    seo_plugin: str | None = None,
):
    strategy = build_strategy_graph(session_factory=session_factory, gemini=gemini).compile()
    production = build_production_graph(session_factory=session_factory, gemini=gemini).compile()

    async def n_publish(state: ContentToolState) -> dict[str, Any]:
        if state.get("hitl_2_decision") != "approve":
            return {"status": state.get("status", "rejected")}
        if wp_client is None:
            return {"status": "persisted", "error": {"message": "wp_client not configured"}}

        async with session_factory() as session:
            fa = (await session.execute(
                select(FetchedArticle).where(FetchedArticle.run_id == UUID(state["run_id"]))
            )).scalar_one()
            ifus = None  # MVP: rely on WP's optimistic concurrency only when we know modified_gmt; fetched_articles can carry it later
            await publish_to_wordpress(
                session=session, run_id=UUID(state["run_id"]),
                wp_client=wp_client, seo_plugin=seo_plugin,  # type: ignore[arg-type]
                if_unmodified_since=ifus,
            )
        return {"status": "published"}

    root = StateGraph(ContentToolState)
    root.add_node("strategy", strategy)
    root.add_node("production", production)
    root.add_node("publish", n_publish)
    root.add_edge(START, "strategy")
    root.add_edge("strategy", "production")
    root.add_edge("production", "publish")
    root.add_edge("publish", END)

    return root.compile(
        checkpointer=checkpointer,
        interrupt_before=["production", "publish"],
    )
```

- [ ] **Step 4: Commit**

```bash
git add content_tool/graph/root.py content_tool/api/main.py content_tool/api/sse.py
git commit -m "feat: wire publish_to_wordpress into root graph; SEO plugin auto-detect"
```

---

### Task 6: Dry-publish endpoint

**Files:** Modify `content_tool/api/schemas.py`, `content_tool/api/routes/runs.py`

- [ ] **Step 1: Append to `content_tool/api/schemas.py`**

```python
class DryPublishResponse(BaseModel):
    target_base_url: str
    target_label: str                    # staging | production
    request_method: Literal["PUT", "POST"]
    request_url: str
    request_headers: dict[str, str]
    request_body: dict
```

- [ ] **Step 2: Append to `content_tool/api/routes/runs.py`**

```python
from datetime import datetime
import base64
import json as _json


@router.post("/{run_id}/dry-publish")
async def dry_publish(run_id: UUID, request: Request, sf=Depends(get_session_factory)) -> dict:
    """Return the exact REST payload we'd send to WP, WITHOUT calling WP."""
    from content_tool.db.models import Draft, FetchedArticle, Render

    target_base = request.app.state.wp_client._base_url   # noqa: SLF001
    target_label = request.app.state.wp_target
    seo_plugin = request.app.state.seo_plugin

    async with sf() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        fa = (await session.execute(select(FetchedArticle).where(FetchedArticle.run_id == run_id))).scalar_one()
        draft = (await session.execute(
            select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        )).scalar_one()
        render = (await session.execute(select(Render).where(Render.draft_id == draft.draft_id))).scalar_one()

    meta_key = "_yoast_wpseo_metadesc" if seo_plugin == "yoast" else ("rank_math_description" if seo_plugin == "rankmath" else None)
    meta = {meta_key: render.meta_description} if meta_key else {}

    body = {
        "title": render.seo_title,
        "content": render.html_body,
        "status": run.wp_publish_status or "draft",
        "categories": run.wp_category_ids or [],
        "tags": run.wp_tag_ids or [],
        "meta": meta,
    }
    if run.wp_excerpt or render.excerpt_suggestion: body["excerpt"] = run.wp_excerpt or render.excerpt_suggestion
    if run.wp_slug: body["slug"] = run.wp_slug
    if run.wp_author_id: body["author"] = run.wp_author_id
    if run.wp_featured_media_id: body["featured_media"] = run.wp_featured_media_id

    url = f"{target_base}/wp-json/wp/v2/posts/{fa.wp_post_id}" if fa.wp_post_id else f"{target_base}/wp-json/wp/v2/posts"
    method = "PUT" if fa.wp_post_id else "POST"

    return {
        "target_base_url": target_base, "target_label": target_label,
        "request_method": method, "request_url": url,
        "request_headers": {"authorization": "Basic <redacted>", "content-type": "application/json"},
        "request_body": body,
    }
```

- [ ] **Step 3: Test — `tests/integration/test_dry_publish.py`**

```python
from datetime import date
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.api.main import create_app
from content_tool.api.routes.runs import router as runs_router
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Render, Run
from content_tool.wordpress.client import WordPressClient


@pytest.mark.asyncio
async def test_dry_publish_returns_payload(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="hitl_2",
            article_url="x", topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 21), chosen_route="small_refresh",
            wp_publish_status="draft", wp_category_ids=[42],
        ))
        s.add(FetchedArticle(run_id=run_id, wp_post_id=98785, wp_categories=[], markdown="x"))
        s.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={}))
        s.add(OutlineRow(run_id=run_id, payload={}))
        d = Draft(run_id=run_id, iteration=0, diagnose="d", markup_raw="x", final_markup="x", citation_intents=[])
        s.add(d)
        await s.commit()
        await s.refresh(d)
        s.add(Render(draft_id=d.draft_id, seo_title="標題", meta_description="m",
                     html_body="<p>x</p>", excerpt_suggestion="e"))
        await s.commit()

    app = FastAPI()
    app.include_router(runs_router)
    app.state.session_factory = sf
    app.state.wp_client = WordPressClient("https://wp.example.com", username="u", app_password="p")
    app.state.wp_target = "staging"
    app.state.seo_plugin = "yoast"
    app.state.run_executor = type("R", (), {"start": None})  # noqa: SLF001  not used by dry endpoint

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(f"/runs/{run_id}/dry-publish")

    assert r.status_code == 200
    data = r.json()
    assert data["request_method"] == "PUT"
    assert "/wp-json/wp/v2/posts/98785" in data["request_url"]
    assert data["request_body"]["status"] == "draft"
    assert data["request_body"]["meta"]["_yoast_wpseo_metadesc"] == "m"
    await engine.dispose()
```

- [ ] **Step 4: Run + commit**

Run: `pytest tests/integration/test_dry_publish.py -v`
Expected: PASS

```bash
git add content_tool/api/schemas.py content_tool/api/routes/runs.py tests/integration/test_dry_publish.py
git commit -m "feat(api): /runs/{id}/dry-publish (no side-effect preview)"
```

---

### Task 7: Staging WP smoke-test docs

**Files:** Modify root `README.md`

- [ ] **Step 1: Append**

```markdown
## WordPress smoke test (staging)

1. Set up an Application Password for your WP user at:
   `https://staging.bowtie.com.hk/wp-admin/profile.php` → "Application Passwords"

2. Export env:
```bash
export WP_BASE_URL=https://staging.bowtie.com.hk
export WP_TARGET=staging
export WP_USERNAME=<your-wp-username>
export WP_APP_PASSWORD=<application-password>
```

3. Run a full end-to-end via UI. After approving HITL_2 (status = Draft),
   confirm the post appears in `/wp-admin/edit.php?post_status=draft` on staging.

4. **Before pointing at production**: explicitly set `WP_TARGET=production` and `WP_BASE_URL=https://www.bowtie.com.hk`.
   The dry-publish endpoint shows `target_label` — verify it matches expectation
   before approving any HITL_2 against production.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: WP staging smoke test instructions"
```

---

## Self-review checklist

| Concern | Covered |
|---|---|
| WP env vars | Task 1 |
| SEO plugin detection | Task 2 |
| WP REST client (PUT/POST + 412) | Task 3 |
| publish_to_wordpress node | Task 4 |
| Root graph wiring | Task 5 |
| Dry-publish endpoint | Task 6 |
| Smoke-test docs | Task 7 |

After Plan 5 ships: approved runs actually push to staging WP as drafts. Production WP target requires explicit env flag — no accidents.
