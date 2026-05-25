# hitl2 prefill from existing WP post + post id display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefill the hitl2 WP-metadata form's Author, Category, and Slug from the existing WP post; show the WP post id as a clickable link in the page header; and give the reviewer a "Re-read from WP" button (with confirm-on-dirty).

**Architecture:** Persist three extra columns (`wp_author_id`, `wp_slug`, `wp_link`) on `FetchedArticle` at run-start fetch time. A new `/existing-post` GET reads the cached row; a `/existing-post/refresh` POST live-refetches from WP and updates the row. The frontend prefills the form once on first resolution, gated by a `prefilledRef` to avoid race-clobber.

**Tech Stack:** Alembic · SQLAlchemy · FastAPI · httpx · respx · pytest-asyncio · Next.js 16 · React 19 · TanStack Query v5 · `@base-ui/react` Dialog

**Spec:** [docs/superpowers/specs/2026-05-26-hitl2-prefill-existing-post-design.md](../specs/2026-05-26-hitl2-prefill-existing-post-design.md)

---

## File Structure

**Backend (Python):**
- Create `migrations/versions/0008_fetched_article_existing_post_fields.py` — three new columns, reversible.
- Modify `content_tool/db/models.py` — three new mapped fields on `FetchedArticle`.
- Modify `content_tool/agents/fetch_article.py` — persist `author`, `slug`, `link` from `FetchedPost`.
- Modify `content_tool/api/schemas.py` — `ExistingPostOut` Pydantic model.
- Modify `content_tool/api/routes/runs.py` — two new endpoints.

**Backend tests:**
- Modify `tests/integration/test_fetch_article_node.py` — assert new columns persist.
- Create `tests/unit/test_existing_post_route.py` — covers both GET and refresh endpoints.

**Frontend:**
- Modify `web/lib/types.ts` — `ExistingPost` interface.
- Modify `web/lib/api.ts` — `getExistingPost`, `refreshExistingPost`.
- Modify `web/app/runs/[runId]/hitl2/page.tsx` — query, prefill effect, kicker link, refresh button, confirm dialog.

---

## Task 1: Migration — add three columns to `fetched_articles`

**Files:**
- Create: `migrations/versions/0008_fetched_article_existing_post_fields.py`

- [ ] **Step 1: Write the migration**

Create `migrations/versions/0008_fetched_article_existing_post_fields.py`:

```python
"""fetched_article_existing_post_fields

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-26
"""

import sqlalchemy as sa

from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade() -> None:
    op.add_column(
        "fetched_articles",
        sa.Column("wp_author_id", sa.Integer(), nullable=True),
        schema="content_tool",
    )
    op.add_column(
        "fetched_articles",
        sa.Column("wp_slug", sa.Text(), nullable=True),
        schema="content_tool",
    )
    op.add_column(
        "fetched_articles",
        sa.Column("wp_link", sa.Text(), nullable=True),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_column("fetched_articles", "wp_link", schema="content_tool")
    op.drop_column("fetched_articles", "wp_slug", schema="content_tool")
    op.drop_column("fetched_articles", "wp_author_id", schema="content_tool")
```

- [ ] **Step 2: Apply and roll back**

```
source .venv/bin/activate
alembic upgrade head
alembic downgrade -1
alembic upgrade head
```

Expected: no errors. Each command finishes cleanly. Verifies the migration is reversible.

- [ ] **Step 3: Commit**

```
git add migrations/versions/0008_fetched_article_existing_post_fields.py
git commit -m "feat(db): add wp_author_id, wp_slug, wp_link to fetched_articles

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Model + fetch_article agent + integration test

**Files:**
- Modify: `content_tool/db/models.py`
- Modify: `content_tool/agents/fetch_article.py`
- Modify: `tests/integration/test_fetch_article_node.py`

- [ ] **Step 1: Update the integration test (TDD red)**

Edit `tests/integration/test_fetch_article_node.py`. After the existing `assert any(c["slug"] == "cancer" for c in row.wp_categories)` line at line 89, append three assertions:

```python
    assert row.wp_author_id == 5
    assert row.wp_slug == "cancer-screening"
    assert row.wp_link == "https://www.bowtie.com.hk/blog/zh/cancer-screening/"
```

- [ ] **Step 2: Run the test to confirm it fails**

```
source .venv/bin/activate
pytest tests/integration/test_fetch_article_node.py -v
```
Expected: FAIL — `AttributeError: 'FetchedArticle' object has no attribute 'wp_author_id'` (or similar).

- [ ] **Step 3: Add the columns to the model**

Edit `content_tool/db/models.py`. In the `FetchedArticle` class (around line 98), after the existing `wp_categories` line, add:

```python
    wp_author_id: Mapped[int | None]
    wp_slug: Mapped[str | None] = mapped_column(String)
    wp_link: Mapped[str | None] = mapped_column(String)
```

- [ ] **Step 4: Persist them in the agent**

Edit `content_tool/agents/fetch_article.py`. The `FetchedArticle(...)` call at line 77 currently passes 5 kwargs (`run_id`, `wp_post_id`, `wp_categories`, `raw_html`, `markdown`). Update it to:

```python
    session.add(
        FetchedArticle(
            run_id=run_id,
            wp_post_id=post.id,
            wp_categories=cats,
            wp_author_id=post.author,
            wp_slug=post.slug,
            wp_link=post.link,
            raw_html=html,
            markdown=markdown,
        )
    )
```

(The agent's return dict can stay as-is — existing callers don't read these fields.)

- [ ] **Step 5: Run tests**

```
pytest tests/integration/test_fetch_article_node.py -v
pytest tests/unit tests/integration -x
```
Expected: green.

- [ ] **Step 6: Commit**

```
git add content_tool/db/models.py content_tool/agents/fetch_article.py tests/integration/test_fetch_article_node.py
git commit -m "feat(fetch): persist wp_author_id/slug/link from existing post

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `ExistingPostOut` Pydantic schema

**Files:**
- Modify: `content_tool/api/schemas.py`

- [ ] **Step 1: Add the schema**

Edit `content_tool/api/schemas.py`. Append after the existing `DryPublishResponse` class (look for `class DryPublishResponse`):

```python
class ExistingPostOut(BaseModel):
    wp_post_id: int
    link: str | None = None
    wp_author_id: int | None = None
    wp_category_id: int | None = None
    wp_slug: str | None = None
```

- [ ] **Step 2: Sanity-import**

```
source .venv/bin/activate
python -c "from content_tool.api.schemas import ExistingPostOut; print(ExistingPostOut.model_json_schema()['required'])"
```
Expected: `['wp_post_id']` (every other field has a default).

- [ ] **Step 3: Commit**

```
git add content_tool/api/schemas.py
git commit -m "feat(api): ExistingPostOut schema for hitl2 prefill

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `GET /runs/{run_id}/existing-post` route

**Files:**
- Modify: `content_tool/api/routes/runs.py`
- Create: `tests/unit/test_existing_post_route.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/test_existing_post_route.py`:

```python
"""Tests for /runs/{run_id}/existing-post GET + refresh."""

from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from content_tool.api.main import create_app
from content_tool.db.models import FetchedArticle, Run


def _seed_run(session_factory):
    """Returns a callable that seeds a run + (optional) fetched_article row.

    Use inside the test for proper async ctx.
    """
    async def _seed(*, with_fetched: bool = True, wp_post_id: int | None = 98785,
                    wp_author_id: int | None = 5,
                    wp_slug: str | None = "cancer-screening",
                    wp_link: str | None = "https://wp.example.com/p/cancer-screening/",
                    wp_categories: list | None = None):
        from datetime import date
        run_id = uuid4()
        async with session_factory() as session:
            session.add(Run(
                run_id=run_id, created_by="x", status="hitl_2",
                article_url="https://wp.example.com/p/cancer-screening/",
                topic="x", keywords=[], mode="auto",
                acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
                today_date=date(2026, 5, 26),
            ))
            if with_fetched:
                session.add(FetchedArticle(
                    run_id=run_id, wp_post_id=wp_post_id,
                    wp_categories=wp_categories if wp_categories is not None
                                  else [{"id": 42, "name": "Cancer", "slug": "cancer"}],
                    wp_author_id=wp_author_id,
                    wp_slug=wp_slug,
                    wp_link=wp_link,
                    raw_html="<p>x</p>", markdown="x",
                ))
            await session.commit()
        return run_id
    return _seed


@pytest.mark.asyncio
async def test_existing_post_returns_cached_row(db_session_factory):
    seed = _seed_run(db_session_factory)
    run_id = await seed()

    app = create_app()
    app.state.session_factory = db_session_factory
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get(f"/runs/{run_id}/existing-post")

    assert r.status_code == 200
    assert r.json() == {
        "wp_post_id": 98785,
        "link": "https://wp.example.com/p/cancer-screening/",
        "wp_author_id": 5,
        "wp_category_id": 42,
        "wp_slug": "cancer-screening",
    }


@pytest.mark.asyncio
async def test_existing_post_404_when_no_fetched_article(db_session_factory):
    seed = _seed_run(db_session_factory)
    run_id = await seed(with_fetched=False)

    app = create_app()
    app.state.session_factory = db_session_factory
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get(f"/runs/{run_id}/existing-post")

    assert r.status_code == 404


@pytest.mark.asyncio
async def test_existing_post_404_when_wp_post_id_null(db_session_factory):
    seed = _seed_run(db_session_factory)
    run_id = await seed(wp_post_id=None)

    app = create_app()
    app.state.session_factory = db_session_factory
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get(f"/runs/{run_id}/existing-post")

    assert r.status_code == 404


@pytest.mark.asyncio
async def test_existing_post_category_id_null_when_no_categories(db_session_factory):
    seed = _seed_run(db_session_factory)
    run_id = await seed(wp_categories=[])

    app = create_app()
    app.state.session_factory = db_session_factory
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get(f"/runs/{run_id}/existing-post")

    assert r.status_code == 200
    assert r.json()["wp_category_id"] is None
```

Notes for the test author:
- `db_session_factory` is the project's existing async test fixture (look at how `tests/integration/test_publish_node.py` uses `db_session` for the per-test session, and `conftest.py` for the factory). If the project fixture name is different, mirror what the other DB-touching tests use. The shape of `_seed_run` should be reusable.
- Tests use ASGITransport against `create_app()` because the route reads from `app.state.session_factory`. The `create_app()` lifespan sets this from settings; we override it here. If `create_app()` requires `lifespan` to populate `wp_client`, you may need to use the `lifespan` properly via a context manager — look at `test_wp_options_routes.py` for the simpler `FastAPI()` + `app.include_router(...)` pattern and copy that approach instead. The point is: the test must NOT hit the real WP, and must be able to set `app.state.session_factory` to the test factory.

If the existing test patterns don't cleanly support `create_app()` setup, switch to the `_make_app` approach from `test_wp_options_routes.py`:

```python
from fastapi import FastAPI
from content_tool.api.routes.runs import router

def _make_app(session_factory) -> FastAPI:
    app = FastAPI()
    app.state.session_factory = session_factory
    app.include_router(router)
    return app
```

Then `_make_app(db_session_factory)` instead of `create_app()`.

- [ ] **Step 2: Run to confirm failure**

```
pytest tests/unit/test_existing_post_route.py -v
```
Expected: ImportError or 404s on the route (it doesn't exist yet).

- [ ] **Step 3: Implement the route**

Edit `content_tool/api/routes/runs.py`.

Add to the existing imports:

```python
from content_tool.api.schemas import (
    CreateRunRequest,
    CreateRunResponse,
    DryPublishResponse,
    ExistingPostOut,         # NEW
    Hitl2Request,
    ResumeRequest,
)
from content_tool.db.models import (
    AuditRun,
    Draft,
    FetchedArticle,          # NEW (move up — currently imported inline in dry_publish)
    GapAnalysisRow,
    OutlineRow,
    RefreshEvaluation,
    Render,
    Run,
)
```

Remove the inline `from content_tool.db.models import FetchedArticle` from inside `dry_publish` now that it's a top-level import.

Add the route handler at the end of the file (after `dry_publish`):

```python
@router.get("/{run_id}/existing-post", response_model=ExistingPostOut)
async def get_existing_post(
    run_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Return the cached snapshot of the existing WP post for this run.

    404 when there's no fetched-article row, or when wp_post_id is null
    (e.g. brand-new-post path).
    """
    async with sf() as session:
        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run_id)
        )).scalar_one_or_none()
    if fa is None or fa.wp_post_id is None:
        raise HTTPException(status_code=404, detail="No existing post")

    cats = fa.wp_categories or []
    first_cat_id = cats[0]["id"] if cats and isinstance(cats[0], dict) and "id" in cats[0] else None

    return {
        "wp_post_id": fa.wp_post_id,
        "link": fa.wp_link,
        "wp_author_id": fa.wp_author_id,
        "wp_category_id": first_cat_id,
        "wp_slug": fa.wp_slug,
    }
```

- [ ] **Step 4: Run tests**

```
pytest tests/unit/test_existing_post_route.py -v
```
Expected: 4 passed.

```
pytest tests/unit -x
```
Expected: green.

- [ ] **Step 5: Commit**

```
git add content_tool/api/routes/runs.py tests/unit/test_existing_post_route.py
git commit -m "feat(api): GET /runs/:id/existing-post returns cached WP post snapshot

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: `POST /runs/{run_id}/existing-post/refresh` route

**Files:**
- Modify: `content_tool/api/routes/runs.py`
- Modify: `tests/unit/test_existing_post_route.py`

- [ ] **Step 1: Append failing tests**

Append to `tests/unit/test_existing_post_route.py`:

```python
from unittest.mock import AsyncMock

from content_tool.wordpress.client import FetchedPost, WordPressError


@pytest.mark.asyncio
async def test_existing_post_refresh_updates_row(db_session_factory):
    seed = _seed_run(db_session_factory)
    run_id = await seed(wp_author_id=5, wp_slug="old-slug", wp_link="https://wp.example.com/old/")

    wp = AsyncMock()
    wp.fetch_post_by_url.return_value = FetchedPost(
        id=98785, slug="new-slug", link="https://wp.example.com/new/",
        title="t", content_html="<p>new</p>", modified_gmt="2026-05-26T00:00:00",
        status="publish", author=7, categories=[42],
    )

    from fastapi import FastAPI
    from content_tool.api.routes.runs import router
    app = FastAPI()
    app.state.session_factory = db_session_factory
    app.state.wp_client = wp
    app.include_router(router)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/existing-post/refresh")

    assert r.status_code == 200
    body = r.json()
    assert body["wp_post_id"] == 98785
    assert body["wp_author_id"] == 7
    assert body["wp_slug"] == "new-slug"
    assert body["link"] == "https://wp.example.com/new/"
    assert body["wp_category_id"] == 42

    # Row was updated
    async with db_session_factory() as session:
        row = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run_id)
        )).scalar_one()
    assert row.wp_author_id == 7
    assert row.wp_slug == "new-slug"
    assert row.wp_link == "https://wp.example.com/new/"
    assert row.wp_categories[0]["id"] == 42


@pytest.mark.asyncio
async def test_existing_post_refresh_404_when_wp_returns_none(db_session_factory):
    seed = _seed_run(db_session_factory)
    run_id = await seed()

    wp = AsyncMock()
    wp.fetch_post_by_url.return_value = None

    from fastapi import FastAPI
    from content_tool.api.routes.runs import router
    app = FastAPI()
    app.state.session_factory = db_session_factory
    app.state.wp_client = wp
    app.include_router(router)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/existing-post/refresh")

    assert r.status_code == 404
    assert "not found" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_existing_post_refresh_502_on_wp_error(db_session_factory):
    seed = _seed_run(db_session_factory)
    run_id = await seed()

    wp = AsyncMock()
    wp.fetch_post_by_url.side_effect = WordPressError("403: sensitive internal text")

    from fastapi import FastAPI
    from content_tool.api.routes.runs import router
    app = FastAPI()
    app.state.session_factory = db_session_factory
    app.state.wp_client = wp
    app.include_router(router)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/existing-post/refresh")

    assert r.status_code == 502
    assert r.json()["detail"] == "WordPress upstream error"
    assert "sensitive internal text" not in r.text
```

Notes:
- These tests mock `wp_client` on `app.state` and rebuild the app with `_make_app` style, since we don't want to hit real WP and we don't want to use `create_app()` (which sets up a real WordPressClient).
- The refresh route updates `wp_categories` to the new category list. For the test, we simplify by using a flat list of ints (no name/slug objects). The route normalizes this (see implementation step). Real WP returns ints in `FetchedPost.categories`; the cat-name resolution is a separate WP call.
- We deliberately DO NOT mock the category-name resolution call. The simplest path: write the route so it stores `wp_categories` as a list of plain id dicts `[{"id": 42}]` when the live fetch only gave us ids. The GET handler already returns `wp_category_id` from `wp_categories[0]["id"]`, which still works. The frontend disambiguation by name only matters in the SearchableSelect dropdown options — those come from `/wp-options/categories`, not from this row. So we can skip the second WP call entirely in the refresh path.

- [ ] **Step 2: Run to confirm failure**

```
pytest tests/unit/test_existing_post_route.py -v -k refresh
```
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement the route**

Add to `content_tool/api/routes/runs.py` at the end of the file:

```python
import logging

logger = logging.getLogger(__name__)
```

(If `logging` is already imported at the top of the file, skip the import statement.)

Then add the route:

```python
@router.post("/{run_id}/existing-post/refresh", response_model=ExistingPostOut)
async def refresh_existing_post(
    run_id: UUID,
    request: Request,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Re-read the existing post from WP and update the cached row.

    Refreshes wp_author_id / wp_slug / wp_link / wp_categories only.
    Leaves raw_html / markdown / wp_post_id intact (those drove the writer).
    """
    from content_tool.wordpress.client import WordPressError

    async with sf() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one_or_none()
        if run is None:
            raise HTTPException(status_code=404, detail="Run not found")

        wp = request.app.state.wp_client
        try:
            post = await wp.fetch_post_by_url(run.article_url)
        except WordPressError as e:
            logger.warning("WordPress refresh failed for run %s: %s", run_id, e)
            raise HTTPException(status_code=502, detail="WordPress upstream error") from e

        if post is None:
            raise HTTPException(status_code=404, detail="Existing post not found on WordPress")

        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run_id)
        )).scalar_one_or_none()
        if fa is None:
            raise HTTPException(status_code=404, detail="No fetched article for this run")

        # Store categories as id-only dicts; name resolution is only needed for
        # the dropdown options endpoint, not for prefill.
        fa.wp_categories = [{"id": cid} for cid in post.categories]
        fa.wp_author_id = post.author
        fa.wp_slug = post.slug
        fa.wp_link = post.link
        await session.commit()

    first_cat_id = post.categories[0] if post.categories else None
    return {
        "wp_post_id": post.id,
        "link": post.link,
        "wp_author_id": post.author,
        "wp_category_id": first_cat_id,
        "wp_slug": post.slug,
    }
```

- [ ] **Step 4: Run tests**

```
pytest tests/unit/test_existing_post_route.py -v
```
Expected: 7 passed (4 from Task 4 + 3 new).

```
pytest tests/unit tests/integration -x
```
Expected: green.

- [ ] **Step 5: Commit**

```
git add content_tool/api/routes/runs.py tests/unit/test_existing_post_route.py
git commit -m "feat(api): POST /runs/:id/existing-post/refresh re-reads from WP

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Frontend types + API helpers

**Files:**
- Modify: `web/lib/types.ts`
- Modify: `web/lib/api.ts`

- [ ] **Step 1: Add the type**

Edit `web/lib/types.ts`. Append at the bottom (after the existing exports):

```typescript
export interface ExistingPost {
  wp_post_id: number;
  link: string | null;
  wp_author_id: number | null;
  wp_category_id: number | null;
  wp_slug: string | null;
}
```

- [ ] **Step 2: Add the API helpers**

Edit `web/lib/api.ts`.

Add `ExistingPost` to the type imports at the top:

```typescript
import type {
  Audit, Article, ArticleDetail, ArticleListResponse, CreateRunRequest, ExistingPost, GapAnalysis,
  Hitl2Request, Outline, RefreshEvaluation, Render, RunSummary, ScanResponse,
  WpCategoryOption, WpUserOption,
} from "./types";
```

(Place `ExistingPost` alphabetically between `CreateRunRequest` and `GapAnalysis`.)

Add two new helpers inside the `api` object (after `resumeHitl2` and before the closing `}`):

```typescript
  getExistingPost: (runId: string) =>
    http<ExistingPost>(`${BASE}/${runId}/existing-post`),
  refreshExistingPost: (runId: string) =>
    http<ExistingPost>(`${BASE}/${runId}/existing-post/refresh`, { method: "POST" }),
```

- [ ] **Step 3: Type-check**

From `web/`:

```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Commit**

```
git add web/lib/types.ts web/lib/api.ts
git commit -m "feat(web): ExistingPost type + api helpers

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Hitl2 page — query, prefill, kicker link, refresh button, dialog

**Files:**
- Modify: `web/app/runs/[runId]/hitl2/page.tsx`

This is the largest frontend change. We add: a React-Query for existing-post, a prefill effect, a `prefilledRef`, a header link, a refresh button, and a confirmation Dialog. The Dialog uses the existing `web/components/ui/dialog.tsx`.

- [ ] **Step 1: Read the current `page.tsx` carefully**

Before editing, read `/Users/franco.ma/Documents/App/ai_content_tool_2/web/app/runs/[runId]/hitl2/page.tsx` end-to-end. It already imports `useQuery`, `useMutation`, `useRef` won't be there yet. Note where the existing prefill effect lives (the `useEffect` that reads `render.data` around line 38).

Also read `/Users/franco.ma/Documents/App/ai_content_tool_2/web/components/ui/dialog.tsx` to confirm the export names of the Dialog parts (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, etc.). Match what's exported.

- [ ] **Step 2: Add imports**

At the top of `page.tsx`:

```tsx
import { use, useEffect, useRef, useState } from "react";  // add useRef
```

Add the queryClient hook to the existing react-query import (if not already present):

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
```

Add Dialog imports (mirror whatever the existing `web/components/ui/dialog.tsx` exports — adjust component names to match):

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
```

Add `ExistingPost` to the types import:

```tsx
import type { ExistingPost, Hitl2Comment, Hitl2Request } from "@/lib/types";
```

- [ ] **Step 3: Add the existing-post query, mutation, and refs**

Inside the `Hitl2Page` component, after the existing `run`, `render`, `audit` queries, add:

```tsx
  const qc = useQueryClient();

  const existingPost = useQuery({
    queryKey: ["existing-post", runId],
    queryFn: () => api.getExistingPost(runId),
    retry: false, // 404 is expected on the new-post path
  });

  const prefilledRef = useRef<ExistingPost | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refresh = useMutation({
    mutationFn: () => api.refreshExistingPost(runId),
    onSuccess: (fresh) => {
      prefilledRef.current = fresh;
      setForm((f) => ({
        ...f,
        wp_author_id: fresh.wp_author_id,
        wp_category_ids: fresh.wp_category_id != null ? [fresh.wp_category_id] : null,
        wp_slug: fresh.wp_slug,
      }));
      qc.setQueryData(["existing-post", runId], fresh);
    },
    onError: () => toast.error("Couldn't re-read from WordPress"),
  });
```

- [ ] **Step 4: Add the prefill effect**

After the existing `useEffect` that reads `render.data`, add a sibling effect:

```tsx
  useEffect(() => {
    if (!existingPost.data) return;
    if (prefilledRef.current !== null) return; // already prefilled
    prefilledRef.current = existingPost.data;
    const ep = existingPost.data;
    setForm((f) => ({
      ...f,
      wp_author_id: ep.wp_author_id,
      wp_category_ids: ep.wp_category_id != null ? [ep.wp_category_id] : null,
      wp_slug: ep.wp_slug,
    }));
  }, [existingPost.data]);
```

- [ ] **Step 5: Add dirty detection + the refresh handler**

After the mutation, add:

```tsx
  function getDirtyFields(): ("Author" | "Category" | "Slug")[] {
    const baseline = prefilledRef.current;
    if (!baseline) return [];
    const dirty: ("Author" | "Category" | "Slug")[] = [];
    if ((form.wp_author_id ?? null) !== (baseline.wp_author_id ?? null)) dirty.push("Author");
    const formCat = form.wp_category_ids?.[0] ?? null;
    if (formCat !== (baseline.wp_category_id ?? null)) dirty.push("Category");
    if ((form.wp_slug ?? null) !== (baseline.wp_slug ?? null)) dirty.push("Slug");
    return dirty;
  }

  function handleRereadClick() {
    if (getDirtyFields().length === 0) {
      refresh.mutate();
    } else {
      setConfirmOpen(true);
    }
  }
```

- [ ] **Step 6: Extend the header kicker**

The existing `<SectionHead kicker={...}>` looks like:

```tsx
        kicker={
          <>
            Galley Proof · Stage 2 · <span className="text-accent">{shortId}</span>
          </>
        }
```

Change it to:

```tsx
        kicker={
          <>
            Galley Proof · Stage 2 · <span className="text-accent">{shortId}</span>
            {existingPost.data?.wp_post_id != null && (
              <>
                {" · "}
                <a
                  href={existingPost.data.link ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  WP #{existingPost.data.wp_post_id} ↗
                </a>
                <button
                  type="button"
                  onClick={handleRereadClick}
                  disabled={refresh.isPending}
                  className="ml-2 font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider disabled:opacity-50"
                >
                  {refresh.isPending ? "↻ Reading…" : "↻ Re-read from WP"}
                </button>
              </>
            )}
          </>
        }
```

- [ ] **Step 7: Add the confirm dialog**

Before the final `</div>` of the page (anywhere outside the main grid is fine — Dialog is portaled), add:

```tsx
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-read from WordPress?</DialogTitle>
            <DialogDescription>
              This will overwrite your edits to: {getDirtyFields().join(", ")}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmOpen(false);
                refresh.mutate();
              }}
            >
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

If `DialogHeader`/`DialogFooter`/`DialogDescription` aren't exported from `dialog.tsx` (they're shadcn extensions, not stock @base-ui), simplify the markup using only what IS exported. Don't invent components.

- [ ] **Step 8: Type-check + smoke-load the page**

From `web/`:

```bash
npx tsc --noEmit
```
Expected: clean.

Then load the page (servers should already be running from earlier work, otherwise restart per Task 8 of the previous plan):

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/runs/5270622b-cc91-4417-95a6-fddf929511ef/hitl2"
```

Expected: 200.

- [ ] **Step 9: Commit**

```
git add web/app/runs/[runId]/hitl2/page.tsx
git commit -m "feat(hitl2): prefill WP fields from existing post + post-id kicker

Adds a /existing-post query that prefills Author / Category / Slug
from the cached fetched-article row, surfaces the WP post id in the
header as a link to the front-end URL, and gives reviewers a
'Re-read from WP' button with a confirm-on-dirty dialog.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Manual UI verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm both servers are running**

```bash
curl -s http://localhost:8000/health
curl -s http://localhost:3000/api/health
```
Both: `{"status":"ok"}`. If backend isn't running, restart per the previous plan's Task 12.

- [ ] **Step 2: Pick a run with a known existing WP post**

Use the run id from the original user prompt: `5270622b-cc91-4417-95a6-fddf929511ef`. Verify it has a fetched_article row with a non-null `wp_post_id`:

```bash
curl -s "http://localhost:3000/api/runs/5270622b-cc91-4417-95a6-fddf929511ef/existing-post" | head -c 300
```

Expected: 200 with JSON body, OR 200/null if the row exists but the new columns are NULL (since the migration backfills as NULL for existing rows). If the columns are NULL, you can hit the refresh endpoint to populate them (next step).

- [ ] **Step 3: Test the refresh endpoint**

```bash
curl -s -X POST "http://localhost:3000/api/runs/5270622b-cc91-4417-95a6-fddf929511ef/existing-post/refresh"
```

Expected: 200 (with fresh data) — OR 502 if WAF blocks (as it does from this dev box). The wiring is correct as long as it's NOT 404.

- [ ] **Step 4: Render the page in a browser**

Use the playwright-cli skill:

```bash
playwright-cli -s=hitl2-prefill open --browser=chrome "http://localhost:3000/runs/5270622b-cc91-4417-95a6-fddf929511ef/hitl2"
playwright-cli -s=hitl2-prefill snapshot
playwright-cli -s=hitl2-prefill screenshot --filename=/tmp/hitl2-prefill.png
playwright-cli -s=hitl2-prefill close
```

Inspect the snapshot for:
- Header includes `WP #<id> ↗` link and `↻ Re-read from WP` button.
- Author / Category / Slug fields prefilled with values from the existing post.
- Clicking the WP # link opens the post's front-end URL in a new tab.

- [ ] **Step 5: Manual dirty-confirm check**

(If your environment lets you interact with the playwright browser session, otherwise document this as a manual step for the reviewer.) Edit the Slug field, click ↻, verify the confirm dialog opens with "Slug" listed. Cancel → slug unchanged. Re-click ↻ → Overwrite → slug snaps to WP value. Click ↻ with no edits → no dialog, mutation fires.

- [ ] **Step 6: Report findings**

Report any issues. If a backfill of `wp_author_id` / `wp_slug` / `wp_link` is needed for older fetched_article rows, note it as a follow-up — for new runs the agent will populate them automatically.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Migration adds three nullable columns, reversible | T1 |
| FetchedArticle model gains the three fields | T2 |
| fetch_article agent persists `author` / `slug` / `link` from FetchedPost | T2 |
| `ExistingPostOut` Pydantic schema | T3 |
| `GET /runs/:id/existing-post` returns cached shape; 404 when missing | T4 |
| `wp_category_id` is first of `wp_categories[]` or null | T4 |
| `POST /runs/:id/existing-post/refresh` live-fetches and updates row | T5 |
| 404 when WP returns None; 502 on WordPressError (with redacted detail) | T5 |
| Frontend `ExistingPost` type + api helpers | T6 |
| React-Query for existing-post, retry false | T7 |
| Prefill effect gated by `prefilledRef !== null` | T7 |
| Header kicker shows `WP #<id> ↗` link to `link` | T7 |
| `↻ Re-read from WP` button with disabled state | T7 |
| Dirty-detection confirm dialog lists which fields are dirty | T7 |
| Manual UI verification | T8 |

**Placeholder scan:** Scanned for "TBD", "TODO", "fill in details" — none. The single conditional in Task 4 step 1 ("look at how `tests/integration/test_publish_node.py` uses `db_session`") is a *navigation* instruction, not a placeholder.

**Type consistency:**

- `ExistingPost` (TS) and `ExistingPostOut` (Pydantic) carry the same five fields with the same nullability.
- `wp_category_id` is `int | None` on the wire; the frontend wraps it in `[id]` when writing to `wp_category_ids: number[] | null` (the existing form field).
- `wp_categories` row column stores either `[{id, name, slug}, ...]` (initial fetch) OR `[{id}, ...]` (refresh). The GET handler reads `wp_categories[0]["id"]` from either shape — both have `id` as a key.

**Risk notes:**

- **Existing rows are not backfilled.** Migration adds NULL columns. For runs that fetched their article *before* this change, the form will show null Author/Slug until the reviewer clicks ↻. Acceptable per spec ("indistinguishable from no existing post").
- **The dialog's component names depend on what `dialog.tsx` exports.** Task 7 step 1 tells the implementer to read the file first; step 7 documents the fallback ("don't invent components").
- **Test fixture name (`db_session_factory`).** Task 4 step 1 calls this out: the project may use a different name. Implementer should mirror what `test_publish_node.py` / `test_wp_options_routes.py` do.
