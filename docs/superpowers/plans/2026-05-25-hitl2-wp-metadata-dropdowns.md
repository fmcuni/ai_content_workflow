# hitl2 WP metadata: searchable author/category dropdowns + post date — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace numeric author / category inputs in the HITL-2 reviewer form with searchable dropdowns sourced live from WordPress, and wire a new HK-time post date picker through to WP REST `date_gmt`.

**Architecture:** Two new GET endpoints (`/wp-options/users`, `/wp-options/categories`) proxy WP REST with pagination + a 10-min in-process TTL cache. Frontend uses `@base-ui/react`'s `Combobox` for an accessible, keyboard-driven searchable select; React Query caches the option lists. The existing `wp_publish_at` DB column gets wired to WP REST via a new `date_gmt` field on `PublishPayload`.

**Tech Stack:** FastAPI · httpx · respx · pytest-asyncio · Next.js 16 (App Router) · React 19 · TanStack Query v5 · `@base-ui/react` Combobox · react-day-picker

**Spec:** [docs/superpowers/specs/2026-05-25-hitl2-wp-metadata-dropdowns-design.md](../specs/2026-05-25-hitl2-wp-metadata-dropdowns-design.md)

---

## File Structure

**Backend (Python):**
- Create `content_tool/api/wp_options_cache.py` — generic async TTL cache (one file, one purpose).
- Create `content_tool/api/routes/wp_options.py` — two read-only routes; depends on cache + `wp_client`.
- Modify `content_tool/wordpress/client.py` — add `WpUser`, `WpCategory` dataclasses, `list_users()`, `list_categories()`, and `date_gmt` on `PublishPayload` / `upsert`.
- Modify `content_tool/agents/publish.py` — pass `date_gmt` derived from `run.wp_publish_at`.
- Modify `content_tool/api/main.py` — register router + instantiate cache on `app.state`.

**Backend tests:**
- Create `tests/unit/test_wp_client_options.py` — pagination + non-JSON guard for `list_users` / `list_categories`.
- Create `tests/unit/test_wp_options_cache.py` — TTL semantics + concurrent coalescing.
- Create `tests/unit/test_wp_options_routes.py` — route returns list shape, surfaces WP errors as 502.
- Modify `tests/unit/test_wp_client.py` — add a case for `date_gmt`.
- Modify `tests/integration/test_publish_node.py` — assert `date_gmt` flows from `run.wp_publish_at` to the WP body (optional touchpoint; only if it's a clean addition).

**Frontend:**
- Create `web/components/SearchableSelect.tsx` — controlled single-select combobox.
- Create `web/components/DateTimeField.tsx` — HK-time date+time picker, emits UTC ISO.
- Modify `web/components/WordPressMetaForm.tsx` — swap author/category fields, add date picker.
- Modify `web/lib/api.ts` — `listWpUsers`, `listWpCategories`.
- Modify `web/next.config.mjs` — rewrite for `/api/wp-options/*`.

---

## Task 1: `WordPressClient.list_categories` with pagination

**Files:**
- Modify: `content_tool/wordpress/client.py`
- Test: `tests/unit/test_wp_client_options.py`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/test_wp_client_options.py`:

```python
"""Unit tests for WordPressClient list_users / list_categories."""

import pytest
import respx
from httpx import Response

from content_tool.wordpress.client import (
    WordPressClient,
    WordPressError,
    WpCategory,
    WpUser,
)


@pytest.fixture()
def client() -> WordPressClient:
    return WordPressClient("https://wp.test", username="user", app_password="pass")  # noqa: S106


@pytest.mark.asyncio
async def test_list_categories_single_page(client: WordPressClient) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get("https://wp.test/wp-json/wp/v2/categories").mock(
            return_value=Response(
                200,
                json=[
                    {"id": 1, "name": "News", "slug": "news"},
                    {"id": 2, "name": "Bowtie Story", "slug": "bowtie-story"},
                ],
                headers={"x-wp-total": "2", "x-wp-totalpages": "1"},
            )
        )
        result = await client.list_categories()
    assert result == [
        WpCategory(id=1, name="News", slug="news"),
        WpCategory(id=2, name="Bowtie Story", slug="bowtie-story"),
    ]


@pytest.mark.asyncio
async def test_list_categories_paginates(client: WordPressClient) -> None:
    page1 = [{"id": i, "name": f"c{i}", "slug": f"c{i}"} for i in range(100)]
    page2 = [{"id": i, "name": f"c{i}", "slug": f"c{i}"} for i in range(100, 107)]
    with respx.mock(assert_all_called=True) as router:
        route = router.get("https://wp.test/wp-json/wp/v2/categories")
        route.mock(side_effect=[
            Response(200, json=page1, headers={"x-wp-total": "107", "x-wp-totalpages": "2"}),
            Response(200, json=page2, headers={"x-wp-total": "107", "x-wp-totalpages": "2"}),
        ])
        result = await client.list_categories()
        # Verify both pages were requested with explicit page params
        assert route.call_count == 2
        first_url = str(route.calls[0].request.url)
        second_url = str(route.calls[1].request.url)
        assert "page=1" in first_url
        assert "per_page=100" in first_url
        assert "hide_empty=false" in first_url
        assert "page=2" in second_url
    assert len(result) == 107
    assert result[0].id == 0
    assert result[-1].id == 106


@pytest.mark.asyncio
async def test_list_categories_raises_on_non_json(client: WordPressClient) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get("https://wp.test/wp-json/wp/v2/categories").mock(
            return_value=Response(
                202,
                content=b"",
                headers={"content-type": "text/html; charset=UTF-8",
                         "x-cache": "Error from cloudfront"},
            )
        )
        with pytest.raises(WordPressError, match="non-JSON"):
            await client.list_categories()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/unit/test_wp_client_options.py -v`
Expected: FAIL — `WpCategory`, `WpUser`, `list_categories` not importable.

- [ ] **Step 3: Implement `WpCategory` and `list_categories`**

Edit `content_tool/wordpress/client.py`. Add near the existing dataclasses:

```python
@dataclass
class WpUser:
    id: int
    name: str
    slug: str


@dataclass
class WpCategory:
    id: int
    name: str
    slug: str
```

Add a private pagination helper and the `list_categories` method on `WordPressClient`:

```python
    async def _list_paginated(
        self,
        path: str,
        *,
        extra_params: dict[str, str] | None = None,
    ) -> list[dict]:
        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            headers = {"authorization": self._auth_header()}
            base_params: dict[str, str] = {
                "per_page": "100",
                "_fields": "id,name,slug",
            }
            if extra_params:
                base_params.update(extra_params)

            page = 1
            total_pages = 1
            results: list[dict] = []
            while True:
                params = {**base_params, "page": str(page)}
                resp = await client.get(
                    f"{self._base_url}{path}",
                    params=params,
                    headers=headers,
                )
                # CloudFront / WAF guard — same shape as fetch_post_by_url.
                ctype = resp.headers.get("content-type", "")
                if not ctype.lower().startswith("application/json") or not resp.content:
                    raise WordPressError(
                        f"WP REST returned non-JSON response ({resp.status_code} "
                        f"{ctype or 'no content-type'}, {len(resp.content)} bytes, "
                        f"x-cache={resp.headers.get('x-cache')!r})."
                    )
                if resp.is_error:
                    raise WordPressError(f"{resp.status_code}: {resp.text}")
                if page == 1:
                    total_pages = int(resp.headers.get("x-wp-totalpages", "1") or "1")
                results.extend(resp.json())
                if page >= total_pages:
                    break
                page += 1
            return results
        finally:
            if own:
                await client.aclose()

    async def list_categories(self) -> list[WpCategory]:
        rows = await self._list_paginated(
            "/wp-json/wp/v2/categories",
            extra_params={"hide_empty": "false"},
        )
        return [WpCategory(id=int(r["id"]), name=r["name"], slug=r["slug"]) for r in rows]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit/test_wp_client_options.py -v`
Expected: All three pass.

- [ ] **Step 5: Commit**

```bash
git add content_tool/wordpress/client.py tests/unit/test_wp_client_options.py
git commit -m "feat(wp): WordPressClient.list_categories with pagination"
```

---

## Task 2: `WordPressClient.list_users`

**Files:**
- Modify: `content_tool/wordpress/client.py`
- Test: `tests/unit/test_wp_client_options.py`

- [ ] **Step 1: Add the failing test**

Append to `tests/unit/test_wp_client_options.py`:

```python
@pytest.mark.asyncio
async def test_list_users_paginates(client: WordPressClient) -> None:
    page1 = [{"id": i, "name": f"u{i}", "slug": f"u{i}"} for i in range(100)]
    page2 = [{"id": i, "name": f"u{i}", "slug": f"u{i}"} for i in range(100, 200)]
    page3 = [{"id": i, "name": f"u{i}", "slug": f"u{i}"} for i in range(200, 266)]
    with respx.mock(assert_all_called=True) as router:
        route = router.get("https://wp.test/wp-json/wp/v2/users")
        route.mock(side_effect=[
            Response(200, json=page1, headers={"x-wp-total": "266", "x-wp-totalpages": "3"}),
            Response(200, json=page2, headers={"x-wp-total": "266", "x-wp-totalpages": "3"}),
            Response(200, json=page3, headers={"x-wp-total": "266", "x-wp-totalpages": "3"}),
        ])
        result = await client.list_users()
        assert route.call_count == 3
        first_url = str(route.calls[0].request.url)
        assert "per_page=100" in first_url
        assert "hide_empty" not in first_url  # users endpoint doesn't take it
    assert len(result) == 266
    assert isinstance(result[0], WpUser)
    assert result[0].id == 0


@pytest.mark.asyncio
async def test_list_users_propagates_4xx(client: WordPressClient) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get("https://wp.test/wp-json/wp/v2/users").mock(
            return_value=Response(
                403,
                json={"code": "rest_user_cannot_view", "message": "Sorry"},
                headers={"content-type": "application/json"},
            )
        )
        with pytest.raises(WordPressError, match="403"):
            await client.list_users()
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pytest tests/unit/test_wp_client_options.py -v -k list_users`
Expected: FAIL — `list_users` not defined.

- [ ] **Step 3: Implement `list_users`**

Add to `WordPressClient` in `content_tool/wordpress/client.py`:

```python
    async def list_users(self) -> list[WpUser]:
        rows = await self._list_paginated("/wp-json/wp/v2/users")
        return [WpUser(id=int(r["id"]), name=r["name"], slug=r["slug"]) for r in rows]
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/unit/test_wp_client_options.py -v`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add content_tool/wordpress/client.py tests/unit/test_wp_client_options.py
git commit -m "feat(wp): WordPressClient.list_users with pagination"
```

---

## Task 3: `TtlCache` for wp-options

**Files:**
- Create: `content_tool/api/wp_options_cache.py`
- Test: `tests/unit/test_wp_options_cache.py`

- [ ] **Step 1: Write failing test**

Create `tests/unit/test_wp_options_cache.py`:

```python
"""Tests for TtlCache used by wp-options endpoints."""

import asyncio

import pytest

from content_tool.api.wp_options_cache import TtlCache


@pytest.mark.asyncio
async def test_cache_returns_loader_result_on_first_call() -> None:
    cache: TtlCache[str] = TtlCache(ttl_seconds=60)
    calls = 0

    async def loader() -> str:
        nonlocal calls
        calls += 1
        return "value"

    assert await cache.get_or_set("k", loader) == "value"
    assert calls == 1


@pytest.mark.asyncio
async def test_cache_does_not_reload_within_ttl() -> None:
    cache: TtlCache[int] = TtlCache(ttl_seconds=60)
    calls = 0

    async def loader() -> int:
        nonlocal calls
        calls += 1
        return calls

    assert await cache.get_or_set("k", loader) == 1
    assert await cache.get_or_set("k", loader) == 1
    assert calls == 1


@pytest.mark.asyncio
async def test_cache_reloads_after_ttl_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]

    def fake_monotonic() -> float:
        return now[0]

    cache: TtlCache[int] = TtlCache(ttl_seconds=10, monotonic=fake_monotonic)
    calls = 0

    async def loader() -> int:
        nonlocal calls
        calls += 1
        return calls

    assert await cache.get_or_set("k", loader) == 1
    now[0] += 5
    assert await cache.get_or_set("k", loader) == 1  # within TTL
    now[0] += 6
    assert await cache.get_or_set("k", loader) == 2  # expired
    assert calls == 2


@pytest.mark.asyncio
async def test_cache_coalesces_concurrent_loaders() -> None:
    cache: TtlCache[str] = TtlCache(ttl_seconds=60)
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def loader() -> str:
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return "value"

    task_a = asyncio.create_task(cache.get_or_set("k", loader))
    task_b = asyncio.create_task(cache.get_or_set("k", loader))
    await started.wait()
    release.set()
    assert await task_a == "value"
    assert await task_b == "value"
    assert calls == 1


@pytest.mark.asyncio
async def test_cache_failure_does_not_poison(monkeypatch: pytest.MonkeyPatch) -> None:
    cache: TtlCache[str] = TtlCache(ttl_seconds=60)
    attempts = 0

    async def flaky() -> str:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("boom")
        return "ok"

    with pytest.raises(RuntimeError):
        await cache.get_or_set("k", flaky)
    assert await cache.get_or_set("k", flaky) == "ok"
    assert attempts == 2
```

- [ ] **Step 2: Run to confirm failure**

Run: `pytest tests/unit/test_wp_options_cache.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TtlCache`**

Create `content_tool/api/wp_options_cache.py`:

```python
"""Async in-process TTL cache used by /wp-options endpoints.

Single-purpose: one instance per app, instantiated on startup and stashed
on app.state. Tests instantiate a fresh cache.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Generic, TypeVar

T = TypeVar("T")


class TtlCache(Generic[T]):
    def __init__(
        self,
        ttl_seconds: float,
        *,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        self._ttl = ttl_seconds
        self._now = monotonic or time.monotonic
        self._entries: dict[str, tuple[float, T]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def get_or_set(
        self,
        key: str,
        loader: Callable[[], Awaitable[T]],
    ) -> T:
        entry = self._entries.get(key)
        if entry is not None and self._now() - entry[0] < self._ttl:
            return entry[1]

        async with self._lock_for(key):
            # Re-check inside the lock — another coroutine may have populated it.
            entry = self._entries.get(key)
            if entry is not None and self._now() - entry[0] < self._ttl:
                return entry[1]
            value = await loader()
            self._entries[key] = (self._now(), value)
            return value
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/unit/test_wp_options_cache.py -v`
Expected: All five pass.

- [ ] **Step 5: Commit**

```bash
git add content_tool/api/wp_options_cache.py tests/unit/test_wp_options_cache.py
git commit -m "feat(api): TtlCache for wp-options"
```

---

## Task 4: `/wp-options` router

**Files:**
- Create: `content_tool/api/routes/wp_options.py`
- Test: `tests/unit/test_wp_options_routes.py`

- [ ] **Step 1: Write failing test**

Create `tests/unit/test_wp_options_routes.py`:

```python
"""Integration tests for /wp-options/* routes."""

from typing import cast
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.api.routes.wp_options import router
from content_tool.api.wp_options_cache import TtlCache
from content_tool.wordpress.client import WordPressError, WpCategory, WpUser


def _make_app(wp_client) -> FastAPI:
    app = FastAPI()
    app.state.wp_client = wp_client
    app.state.wp_options_cache = TtlCache(ttl_seconds=60)
    app.include_router(router)
    return app


@pytest.mark.asyncio
async def test_users_returns_serialized_list() -> None:
    wp = AsyncMock()
    wp.list_users.return_value = [
        WpUser(id=5, name="Editor", slug="editor"),
        WpUser(id=9, name="Author", slug="author"),
    ]
    app = _make_app(wp)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/users")
    assert r.status_code == 200
    assert r.json() == [
        {"id": 5, "name": "Editor", "slug": "editor"},
        {"id": 9, "name": "Author", "slug": "author"},
    ]
    assert wp.list_users.await_count == 1


@pytest.mark.asyncio
async def test_categories_uses_cache_for_second_call() -> None:
    wp = AsyncMock()
    wp.list_categories.return_value = [WpCategory(id=1, name="News", slug="news")]
    app = _make_app(wp)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r1 = await c.get("/wp-options/categories")
        r2 = await c.get("/wp-options/categories")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json() == r2.json()
    assert wp.list_categories.await_count == 1


@pytest.mark.asyncio
async def test_users_surfaces_wp_error_as_502() -> None:
    wp = AsyncMock()
    wp.list_users.side_effect = WordPressError("403: forbidden")
    app = _make_app(wp)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/users")
    assert r.status_code == 502
    assert "forbidden" in r.json()["detail"]
```

- [ ] **Step 2: Run to confirm failure**

Run: `pytest tests/unit/test_wp_options_routes.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router**

Create `content_tool/api/routes/wp_options.py`:

```python
"""Read-only proxy endpoints for WordPress users / categories.

Used by the HITL-2 reviewer form to populate searchable dropdowns.
TTL-cached on app.state.wp_options_cache.
"""

from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request

from content_tool.wordpress.client import WordPressError

router = APIRouter(prefix="/wp-options", tags=["wp-options"])


@router.get("/users")
async def list_users(request: Request) -> list[dict]:
    cache = request.app.state.wp_options_cache
    wp = request.app.state.wp_client
    try:
        users = await cache.get_or_set("users", wp.list_users)
    except WordPressError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return [asdict(u) for u in users]


@router.get("/categories")
async def list_categories(request: Request) -> list[dict]:
    cache = request.app.state.wp_options_cache
    wp = request.app.state.wp_client
    try:
        cats = await cache.get_or_set("categories", wp.list_categories)
    except WordPressError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return [asdict(c) for c in cats]
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/unit/test_wp_options_routes.py -v`
Expected: All three pass.

- [ ] **Step 5: Commit**

```bash
git add content_tool/api/routes/wp_options.py tests/unit/test_wp_options_routes.py
git commit -m "feat(api): /wp-options routes for users and categories"
```

---

## Task 5: Wire router and cache into FastAPI app

**Files:**
- Modify: `content_tool/api/main.py`

- [ ] **Step 1: Wire the cache and router**

Edit `content_tool/api/main.py`:

Add import alongside other route imports:

```python
from content_tool.api.routes.wp_options import router as wp_options_router
```

Add cache import near the top:

```python
from content_tool.api.wp_options_cache import TtlCache
```

In `lifespan`, after the `wp_client = WordPressClient(...)` line, before stashing on state:

```python
    app.state.wp_options_cache = TtlCache(ttl_seconds=600)
```

In `create_app`, register the router with the others:

```python
    app.include_router(wp_options_router)
```

- [ ] **Step 2: Verify the app starts**

Run: `python -c "from content_tool.api.main import create_app; app = create_app(); print(sorted(r.path for r in app.routes))" | tr ',' '\n' | grep wp-options`
Expected: Output contains `/wp-options/users` and `/wp-options/categories`.

- [ ] **Step 3: Run the full backend test suite to confirm nothing else broke**

Run: `pytest tests/unit -x`
Expected: PASS (existing + new).

- [ ] **Step 4: Commit**

```bash
git add content_tool/api/main.py
git commit -m "feat(api): register wp-options router and cache"
```

---

## Task 6: `date_gmt` on `PublishPayload` + WP client

**Files:**
- Modify: `content_tool/wordpress/client.py`
- Modify: `tests/unit/test_wp_client.py`

- [ ] **Step 1: Add the failing test**

Append to `tests/unit/test_wp_client.py`:

```python
@pytest.mark.asyncio
async def test_publish_includes_date_gmt_when_set():
    raw = Path("tests/fixtures/wp_responses/publish_response.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    expected_resp = json.loads(raw)
    with respx.mock(assert_all_called=True) as r:
        route = r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json=expected_resp)
        )
        client = WordPressClient(
            "https://wp.example.com", username="user", app_password="pass"  # noqa: S106
        )
        await client.upsert(PublishPayload(
            post_id=98785, title="x", content="<p>x</p>", excerpt="x",
            status="future", slug="x", categories=[42], tags=[],
            author=5, featured_media=None, meta={},
            if_unmodified_since=None,
            date_gmt="2026-06-01T03:00:00",
        ))
        body = json.loads(route.calls.last.request.content)
        assert body["date_gmt"] == "2026-06-01T03:00:00"


@pytest.mark.asyncio
async def test_publish_omits_date_gmt_when_none():
    raw = Path("tests/fixtures/wp_responses/publish_response.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    expected_resp = json.loads(raw)
    with respx.mock(assert_all_called=True) as r:
        route = r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json=expected_resp)
        )
        client = WordPressClient(
            "https://wp.example.com", username="user", app_password="pass"  # noqa: S106
        )
        await client.upsert(PublishPayload(
            post_id=98785, title="x", content="<p>x</p>", excerpt="x",
            status="draft", slug=None, categories=[], tags=[],
            author=None, featured_media=None, meta={},
            if_unmodified_since=None,
            date_gmt=None,
        ))
        body = json.loads(route.calls.last.request.content)
        assert "date_gmt" not in body
```

- [ ] **Step 2: Run to confirm failure**

Run: `pytest tests/unit/test_wp_client.py -v -k date_gmt`
Expected: FAIL — `PublishPayload` has no `date_gmt` field.

- [ ] **Step 3: Add `date_gmt` to `PublishPayload` and `upsert`**

Edit `content_tool/wordpress/client.py`:

Update the dataclass:

```python
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
    date_gmt: str | None = None
```

In `upsert`, after the existing `if p.featured_media is not None:` block:

```python
            if p.date_gmt is not None:
                body["date_gmt"] = p.date_gmt
```

- [ ] **Step 4: Update existing `PublishPayload(...)` constructions in tests**

The existing two tests in `test_wp_client.py` construct `PublishPayload` positionally — `date_gmt` has a default so they still pass. Verify by running:

Run: `pytest tests/unit/test_wp_client.py -v`
Expected: All four pass (two existing + two new).

- [ ] **Step 5: Run other call sites and adjust if needed**

Run: `grep -rn "PublishPayload(" content_tool tests --include="*.py"`
Expected: Confirm the only call sites are `agents/publish.py`, `test_wp_client.py`, and `tests/integration/test_publish_node.py` / `tests/integration/test_dry_publish.py`. All use keyword args or positional matching the existing field order; `date_gmt` has a default so they still compile.

Run: `pytest tests/unit -x`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add content_tool/wordpress/client.py tests/unit/test_wp_client.py
git commit -m "feat(wp): PublishPayload.date_gmt forwards to WP REST"
```

---

## Task 7: Wire `wp_publish_at` → `date_gmt` in publish agent

**Files:**
- Modify: `content_tool/agents/publish.py`
- Test: `tests/integration/test_publish_node.py`

- [ ] **Step 1: Inspect existing integration test for shape**

Run: `pytest tests/integration/test_publish_node.py -v -k existing 2>&1 | head -20`
(Just read the test to understand fixtures.) Then open `tests/integration/test_publish_node.py` and find the test that exercises `publish_to_wordpress` with an existing post. Note the fixture builder pattern.

- [ ] **Step 2: Add a failing test**

Append a new test to `tests/integration/test_publish_node.py` modeled on the existing one but setting `wp_publish_at`. Example body (adapt to that file's existing fixture builders; if it uses helpers like `_seed_run`, follow that style):

```python
from datetime import datetime, timezone

@pytest.mark.asyncio
async def test_publish_node_forwards_wp_publish_at_as_date_gmt(
    session_factory,  # whatever fixture is already in use
):
    # Use the file's existing seed helper. Add wp_publish_at as an aware UTC datetime,
    # but request "HK 11:00 on 2026-06-01" → UTC 03:00.
    publish_at = datetime(2026, 6, 1, 3, 0, 0, tzinfo=timezone.utc)
    run_id = await _seed_run_for_publish(  # whatever the existing helper is called
        session_factory,
        wp_publish_at=publish_at,
        wp_publish_status="future",
    )

    captured_bodies: list[dict] = []
    with respx.mock(assert_all_called=True) as r:
        route = r.post("https://wp.test/wp-json/wp/v2/posts").mock(
            return_value=Response(200, json={
                "id": 123, "link": "https://wp.test/?p=123",
                "status": "future", "modified_gmt": "2026-05-25T00:00:00",
                "slug": "x",
            })
        )
        # ...call publish_to_wordpress as the existing test does...
        await publish_to_wordpress(session=..., run_id=run_id, wp_client=..., seo_plugin=None, if_unmodified_since=None)
        captured_bodies.append(json.loads(route.calls.last.request.content))

    assert captured_bodies[0]["date_gmt"] == "2026-06-01T03:00:00"
```

If the existing test file does NOT have a reusable seed helper, skip this test and rely on the unit test in Task 6 — note that explicitly in the commit message.

- [ ] **Step 3: Run to confirm failure (or skip if no helper)**

Run: `pytest tests/integration/test_publish_node.py::test_publish_node_forwards_wp_publish_at_as_date_gmt -v`
Expected: FAIL (`date_gmt` not in body).

- [ ] **Step 4: Modify `publish.py`**

Edit `content_tool/agents/publish.py`:

Update import:

```python
from datetime import datetime, timezone
```

Inside `publish_to_wordpress`, before building the `PublishPayload`:

```python
    date_gmt: str | None = None
    if run.wp_publish_at is not None:
        date_gmt = run.wp_publish_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
```

Add `date_gmt=date_gmt` to the `PublishPayload(...)` call.

- [ ] **Step 5: Run tests**

Run: `pytest tests/integration/test_publish_node.py -v`
Expected: PASS.

Run: `pytest tests/unit tests/integration -x`
Expected: All green.

- [ ] **Step 6: Commit**

```bash
git add content_tool/agents/publish.py tests/integration/test_publish_node.py
git commit -m "feat(publish): forward wp_publish_at as WP date_gmt"
```

---

## Task 8: Next.js rewrite + API client helpers

**Files:**
- Modify: `web/next.config.mjs`
- Modify: `web/lib/api.ts`
- Modify: `web/lib/types.ts` (small addition)

- [ ] **Step 1: Add the rewrite**

Edit `web/next.config.mjs`. In the `rewrites()` array, after the existing entries:

```javascript
      { source: "/api/wp-options/:path*", destination: `${apiBase}/wp-options/:path*` },
```

- [ ] **Step 2: Add types**

Edit `web/lib/types.ts`. Append:

```typescript
export interface WpUserOption { id: number; name: string; slug: string }
export interface WpCategoryOption { id: number; name: string; slug: string }
```

- [ ] **Step 3: Add api helpers**

Edit `web/lib/api.ts`. Add the new imports:

```typescript
import type { ..., WpCategoryOption, WpUserOption } from "./types";
```

Add to the `api` object (alongside `resumeHitl2`):

```typescript
  listWpUsers: () => http<WpUserOption[]>("/api/wp-options/users"),
  listWpCategories: () => http<WpCategoryOption[]>("/api/wp-options/categories"),
```

- [ ] **Step 4: Smoke-check the dev server boots and the new rewrite resolves**

In `web/`:

```bash
npm run dev
```

In another shell, with the FastAPI backend running, curl through Next:

```bash
curl -i http://localhost:3000/api/wp-options/users | head -5
```

Expected: 200 (or 502 if WP unreachable from dev box — that's fine; what matters is that Next routed it to the backend, not a 404).

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add web/next.config.mjs web/lib/api.ts web/lib/types.ts
git commit -m "feat(web): wp-options proxy + api helpers"
```

---

## Task 9: `SearchableSelect` component

**Files:**
- Create: `web/components/SearchableSelect.tsx`

- [ ] **Step 1: Create the component**

Create `web/components/SearchableSelect.tsx`:

```tsx
"use client";
import { Combobox } from "@base-ui/react/combobox";
import { useMemo } from "react";

import { cn } from "@/lib/utils";

export interface SearchableSelectOption {
  id: number;
  name: string;
  slug: string;
}

interface Props {
  value: number | null;
  onChange: (v: number | null) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  disabled?: boolean;
  className?: string;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Search…",
  loading,
  error,
  onRetry,
  disabled,
  className,
}: Props) {
  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);

  // If two options share the same name, append " · slug" to disambiguate.
  const labelById = useMemo(() => {
    const nameCount = new Map<string, number>();
    for (const o of options) nameCount.set(o.name, (nameCount.get(o.name) ?? 0) + 1);
    const result = new Map<number, string>();
    for (const o of options) {
      const dup = (nameCount.get(o.name) ?? 0) > 1;
      result.set(o.id, dup ? `${o.name} · ${o.slug}` : o.name);
    }
    return result;
  }, [options]);

  if (error) {
    return (
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          "flex h-9 w-full items-center justify-between border-b border-rule px-0 py-1.5 text-[13px] text-accent-deep",
          className,
        )}
      >
        Failed — retry
      </button>
    );
  }

  const triggerLabel = loading
    ? "Loading…"
    : selected
    ? labelById.get(selected.id) ?? selected.name
    : placeholder;

  return (
    <Combobox.Root
      items={options}
      value={selected}
      onValueChange={(v) => onChange(v == null ? null : (v as SearchableSelectOption).id)}
      itemToStringLabel={(o) => labelById.get((o as SearchableSelectOption).id) ?? (o as SearchableSelectOption).name}
      itemToStringValue={(o) => String((o as SearchableSelectOption).id)}
      isItemEqualToValue={(a, b) =>
        (a as SearchableSelectOption).id === (b as SearchableSelectOption).id
      }
      disabled={disabled || loading}
    >
      <Combobox.Trigger
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 border-b border-rule bg-transparent px-0 py-1.5 text-left text-[13px] text-ink focus-visible:border-b-2 focus-visible:border-accent disabled:opacity-50",
          className,
        )}
      >
        <Combobox.Value>{triggerLabel}</Combobox.Value>
        {selected != null && !disabled && !loading && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange(null);
            }}
            className="text-ink-faint hover:text-ink"
          >
            ✕
          </span>
        )}
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="z-50">
          <Combobox.Popup className="max-h-[280px] w-[var(--anchor-width)] overflow-auto border border-rule bg-paper p-1 text-[13px] shadow-md">
            <div className="px-2 py-1">
              <Combobox.Input
                placeholder="Type to filter…"
                className="w-full border-b border-rule bg-transparent px-0 py-1 outline-none focus:border-accent"
              />
            </div>
            <Combobox.List className="py-1">
              <Combobox.Empty className="px-3 py-2 text-ink-faint">No match</Combobox.Empty>
              {(item: SearchableSelectOption) => (
                <Combobox.Item
                  key={item.id}
                  value={item}
                  className="cursor-pointer px-3 py-1.5 data-[highlighted]:bg-rule/40"
                >
                  {labelById.get(item.id) ?? item.name}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
```

- [ ] **Step 2: Type-check**

Run from `web/`:

```bash
npx tsc --noEmit
```

Expected: No errors related to `SearchableSelect.tsx`. (Other unrelated errors in the project might exist; do not fix them — just confirm none cite this new file.)

If `Combobox` props differ from what's shown (e.g. `items` arg name, or render-prop signature for `Combobox.List`), open `web/node_modules/@base-ui/react/combobox/index.d.ts` and the per-part `.d.ts` files to find the exact names, and adjust this component to match. Do not invent props.

- [ ] **Step 3: Commit**

```bash
git add web/components/SearchableSelect.tsx
git commit -m "feat(web): SearchableSelect component"
```

---

## Task 10: `DateTimeField` component (HK-time)

**Files:**
- Create: `web/components/DateTimeField.tsx`

- [ ] **Step 1: Create the component**

Create `web/components/DateTimeField.tsx`:

```tsx
"use client";
import { Popover } from "@base-ui/react/popover";
import { useMemo, useState } from "react";

import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";

interface Props {
  value: string | null;          // UTC ISO with trailing Z (e.g. "2026-06-01T03:00:00Z")
  onChange: (v: string | null) => void;
  label?: string;
}

const HK_OFFSET_MINUTES = 8 * 60;

function utcIsoToHkParts(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  // Shift the wall clock by +8h then read UTC fields — gives us HK YMDhm regardless of browser TZ.
  const shifted = new Date(d.getTime() + HK_OFFSET_MINUTES * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return { date: `${y}-${m}-${day}`, time: `${hh}:${mm}` };
}

function hkPartsToUtcIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  // Build "YYYY-MM-DDTHH:mm:00+08:00" — JS parses this and converts to UTC.
  const d = new Date(`${date}T${time}:00+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function DateTimeField({ value, onChange, label }: Props) {
  const { date, time } = useMemo(() => utcIsoToHkParts(value), [value]);
  const [open, setOpen] = useState(false);

  const dateObj = useMemo(() => (date ? new Date(`${date}T00:00:00`) : undefined), [date]);

  const setDate = (next: Date | undefined) => {
    if (!next) {
      onChange(null);
      setOpen(false);
      return;
    }
    const y = next.getFullYear();
    const m = String(next.getMonth() + 1).padStart(2, "0");
    const d = String(next.getDate()).padStart(2, "0");
    const newDate = `${y}-${m}-${d}`;
    onChange(hkPartsToUtcIso(newDate, time || "09:00"));
    setOpen(false);
  };

  const setTime = (t: string) => {
    if (!date) {
      // Default to today if user picks a time first.
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, "0");
      const d = String(today.getDate()).padStart(2, "0");
      onChange(hkPartsToUtcIso(`${y}-${m}-${d}`, t));
    } else {
      onChange(hkPartsToUtcIso(date, t));
    }
  };

  return (
    <div>
      {label && <div className="mb-1 text-[12px] text-ink-faint">{label}</div>}
      <div className="flex items-center gap-2">
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger
            className={cn(
              "flex h-9 flex-1 items-center border-b border-rule bg-transparent px-0 py-1.5 text-left text-[13px] text-ink",
              !date && "text-ink-faint",
            )}
          >
            {date || "Pick a date"}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner sideOffset={4} className="z-50">
              <Popover.Popup className="border border-rule bg-paper shadow-md">
                <Calendar mode="single" selected={dateObj} onSelect={setDate} />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="h-9 w-[110px] border-b border-rule bg-transparent px-0 py-1.5 text-[13px] text-ink"
        />
        {value != null && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[13px] text-ink-faint hover:text-ink"
            aria-label="Clear"
          >
            ✕
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">
        Hong Kong time. Leave blank to use WP default.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run from `web/`:

```bash
npx tsc --noEmit
```

Expected: No errors citing `DateTimeField.tsx`. If `Popover` from `@base-ui/react/popover` exports parts differently, open `web/node_modules/@base-ui/react/popover/index.d.ts` and adjust accordingly. Don't invent props.

- [ ] **Step 3: Commit**

```bash
git add web/components/DateTimeField.tsx
git commit -m "feat(web): DateTimeField HK-time picker"
```

---

## Task 11: Wire dropdowns and date picker into `WordPressMetaForm`

**Files:**
- Modify: `web/components/WordPressMetaForm.tsx`

- [ ] **Step 1: Replace the form**

Edit `web/components/WordPressMetaForm.tsx`. Replace the entire file with:

```tsx
"use client";
import { useQuery } from "@tanstack/react-query";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DateTimeField } from "@/components/DateTimeField";
import { SearchableSelect } from "@/components/SearchableSelect";
import { api } from "@/lib/api";

import type { Hitl2Request } from "@/lib/types";

const TEN_MIN = 10 * 60_000;
const THIRTY_MIN = 30 * 60_000;

export function WordPressMetaForm({
  form, onChange,
}: { form: Hitl2Request; onChange: (f: Hitl2Request) => void }) {
  const users = useQuery({
    queryKey: ["wp-users"],
    queryFn: api.listWpUsers,
    staleTime: TEN_MIN,
    gcTime: THIRTY_MIN,
  });
  const categories = useQuery({
    queryKey: ["wp-categories"],
    queryFn: api.listWpCategories,
    staleTime: TEN_MIN,
    gcTime: THIRTY_MIN,
  });

  return (
    <div className="space-y-3 text-sm">
      <div>
        <Label>SEO title</Label>
        <Input value={form.edited_seo_title ?? ""} onChange={(e) => onChange({ ...form, edited_seo_title: e.target.value })} />
      </div>
      <div>
        <Label>Meta description</Label>
        <Textarea value={form.edited_meta_description ?? ""} rows={2}
                  onChange={(e) => onChange({ ...form, edited_meta_description: e.target.value })} />
      </div>
      <div>
        <Label>Slug (leave blank to preserve)</Label>
        <Input value={form.wp_slug ?? ""} onChange={(e) => onChange({ ...form, wp_slug: e.target.value || null })} />
      </div>
      <div>
        <Label>Excerpt</Label>
        <Textarea value={form.wp_excerpt ?? ""} rows={2}
                  onChange={(e) => onChange({ ...form, wp_excerpt: e.target.value || null })} />
      </div>
      <div>
        <Label>Publish status</Label>
        <Select value={form.wp_publish_status} onValueChange={(v) => onChange({ ...form, wp_publish_status: v as Hitl2Request["wp_publish_status"] })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">Draft (recommended)</SelectItem>
            <SelectItem value="future">Schedule</SelectItem>
            <SelectItem value="publish">Publish now</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>Author</Label>
        <SearchableSelect
          value={form.wp_author_id ?? null}
          onChange={(v) => onChange({ ...form, wp_author_id: v })}
          options={users.data ?? []}
          loading={users.isPending}
          error={users.isError ? (users.error as Error).message : null}
          onRetry={() => { void users.refetch(); }}
          placeholder="Search author…"
        />
      </div>
      <div>
        <Label>Category</Label>
        <SearchableSelect
          value={form.wp_category_ids?.[0] ?? null}
          onChange={(v) => onChange({ ...form, wp_category_ids: v == null ? null : [v] })}
          options={categories.data ?? []}
          loading={categories.isPending}
          error={categories.isError ? (categories.error as Error).message : null}
          onRetry={() => { void categories.refetch(); }}
          placeholder="Search category…"
        />
      </div>
      <div>
        <Label>Tag IDs (comma)</Label>
        <Input value={form.wp_tag_ids?.join(",") ?? ""}
               onChange={(e) => onChange({ ...form, wp_tag_ids: e.target.value ? e.target.value.split(",").map(s => parseInt(s.trim(), 10)) : null })} />
      </div>
      <div>
        <Label>Featured media id</Label>
        <Input type="number" value={form.wp_featured_media_id ?? ""}
               onChange={(e) => onChange({ ...form, wp_featured_media_id: e.target.value ? parseInt(e.target.value, 10) : null })} />
      </div>
      <div>
        <Label>Post date (optional)</Label>
        <DateTimeField
          value={form.wp_publish_at ?? null}
          onChange={(v) => onChange({ ...form, wp_publish_at: v })}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run from `web/`:

```bash
npx tsc --noEmit
```

Expected: No new errors. If anything fails, fix the offending lines (most likely: `Combobox` render-prop signature or `Popover` parts). Don't introduce `any`.

- [ ] **Step 3: Commit**

```bash
git add web/components/WordPressMetaForm.tsx
git commit -m "feat(web): wire searchable author/category and date picker"
```

---

## Task 12: Manual UI verification

**Files:** None (verification only).

- [ ] **Step 1: Start the backend**

In one shell, with venv activated and `.env.local` present:

```bash
uvicorn content_tool.api.main:app --reload
```

Expected: Server listens on `:8000`, no errors mentioning `wp_options`.

- [ ] **Step 2: Start the web dev server**

In another shell:

```bash
cd web && npm run dev
```

Expected: Next dev server on `:3000`, no compile errors.

- [ ] **Step 3: Open a HITL-2 page that's awaiting review**

Open: `http://localhost:3000/runs/<runId>/hitl2` — use any run that's in `hitl_2` status, e.g. `5270622b-cc91-4417-95a6-fddf929511ef`.

Verify in the right rail:

1. Author dropdown loads. Typing filters by name and slug. Two "Bowtie Story" entries show distinct `· slug` suffixes.
2. Category dropdown loads. Typing filters. Selecting one updates `form.wp_category_ids` to `[id]`.
3. Clearing (`✕`) returns the field to placeholder.
4. Date picker opens calendar, lets you pick a date, the time input updates wall-clock.
5. Picking 2026-06-01 11:00 HKT serializes to `2026-06-01T03:00:00Z` (use DevTools network tab on Approve).

- [ ] **Step 4: Approve a run end-to-end against a non-production target**

This is the highest-confidence check that `date_gmt` flows through. Pick a run targeting a non-production WP environment (whatever the team uses for safe end-to-end checks); approve with a future date set. Expected: WP returns 200, the resulting post has `date_gmt` matching what was sent, status `future`.

- [ ] **Step 5: Capture a screenshot for the PR**

```bash
cd web && npx playwright screenshot --device "Desktop Chrome" http://localhost:3000/runs/<runId>/hitl2 /tmp/hitl2-after.png
```

(Or use the playwright-cli skill.) Attach to the PR.

- [ ] **Step 6: Stop servers and commit any leftover changes**

There should be nothing to commit at this point — manual verification doesn't change code. If you noticed any small polish issues, fix them in their own commits before opening the PR.

---

## Self-Review

**Spec coverage check:**

- [x] Author searchable dropdown — Tasks 1, 3, 4, 5, 8, 9, 11.
- [x] Category searchable dropdown — Tasks 1, 3, 4, 5, 8, 9, 11.
- [x] Pagination — Tasks 1, 2.
- [x] TTL cache (10 min, coalescing) — Tasks 3, 4, 5.
- [x] WordPressError → 502 surfacing — Task 4.
- [x] Frontend cache (React Query, 10 min) — Task 11.
- [x] Disambiguate duplicate names by slug — Task 9.
- [x] Loading / error / retry trigger state — Task 9.
- [x] Date picker (HK time, optional, UTC ISO output) — Task 10.
- [x] WP `date_gmt` wire-through — Tasks 6, 7.
- [x] Next.js rewrite — Task 8.
- [x] Manual UI verification — Task 12.

**Risk notes:**

- Task 7 depends on the integration test file's existing fixture style. The plan tells the engineer to inspect first and skip if there's no reusable helper; in that case Task 6's unit test still covers the `date_gmt` body assertion at the WP-client layer.
- Tasks 9 / 10 depend on the exact shape of `@base-ui/react`'s `Combobox` and `Popover` exports. The plan calls this out and tells the engineer to read the `.d.ts` files if a prop mismatch shows up.
- No new pyright errors expected; if any appear they're isolated to the new files since existing code is untouched (Tasks 1–7 only add code or extend dataclasses with defaulted fields).
