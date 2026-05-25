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
