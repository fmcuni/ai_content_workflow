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
