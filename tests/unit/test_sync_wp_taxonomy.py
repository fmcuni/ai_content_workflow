"""Unit tests for the per-target WP taxonomy sync.

`_refresh_target` and `_run_targets` are exercised with a recording fake session
and fake WordPress clients, so these stay pure unit tests (no DB, no network).
They lock in the two behaviours the per-target cache depends on:

  1. Each target hard-refreshes *only its own* `auth_ref` rows (delete-then-
     insert, scoped) so one instance's snapshot never clobbers another's.
  2. One target's upstream failure is logged + skipped (rc=2) while the others
     still refresh — a VHIS101 WAF block must not blank the Bowtie cache.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from content_tool.wordpress.client import WordPressError
from scripts.sync_wp_taxonomy import _refresh_target, _run_targets

NOW = datetime(2026, 6, 8, tzinfo=UTC)


@dataclass
class _Entity:
    """Stand-in for a WP user / category (only id/name/slug are read)."""

    id: int
    name: str
    slug: str


class _FakeClient:
    """Returns canned user/category lists, or raises on the users fetch."""

    def __init__(
        self,
        users: list[_Entity],
        cats: list[_Entity],
        *,
        fail: bool = False,
    ) -> None:
        self._users = users
        self._cats = cats
        self._fail = fail

    async def list_users(self) -> list[_Entity]:
        if self._fail:
            raise WordPressError("WAF challenge")
        return self._users

    async def list_categories(self) -> list[_Entity]:
        return self._cats


class _RecordingSession:
    """Captures every executed statement; `execute` is a no-op otherwise."""

    def __init__(self) -> None:
        self.statements: list[object] = []

    async def execute(self, stmt: object) -> None:
        self.statements.append(stmt)


def _kind(stmt: object) -> str:
    return type(stmt).__name__  # "Insert" | "Delete"


def _table(stmt: object) -> str:
    return stmt.table.name  # type: ignore[attr-defined]


def _inserted_rows(stmt: object) -> list[dict[str, object]]:
    """Pull the row dicts out of an `insert(...).values([...])` statement."""
    multi = getattr(stmt, "_multi_values", ())
    if not multi:
        return []
    return [{col.name: val for col, val in row.items()} for row in multi[0]]


async def test_refresh_target_clears_then_inserts_scoped_rows() -> None:
    session = _RecordingSession()
    client = _FakeClient(
        users=[_Entity(5, "Alice", "alice"), _Entity(7, "Bob", "bob")],
        cats=[_Entity(12, "Health", "health")],
    )

    counts = await _refresh_target(session, "VHIS101_WP", client, NOW)  # type: ignore[arg-type]

    assert counts == (2, 1)
    # delete users, insert users, delete categories, insert categories — in order.
    shape = [(_kind(s), _table(s)) for s in session.statements]
    assert shape == [
        ("Delete", "wp_users"),
        ("Insert", "wp_users"),
        ("Delete", "wp_categories"),
        ("Insert", "wp_categories"),
    ]

    user_rows = _inserted_rows(session.statements[1])
    assert {r["id"] for r in user_rows} == {5, 7}
    assert all(r["auth_ref"] == "VHIS101_WP" for r in user_rows)
    assert all(r["synced_at"] == NOW for r in user_rows)

    cat_rows = _inserted_rows(session.statements[3])
    assert [r["id"] for r in cat_rows] == [12]
    assert cat_rows[0]["auth_ref"] == "VHIS101_WP"


async def test_refresh_target_clears_without_inserting_when_empty() -> None:
    session = _RecordingSession()
    client = _FakeClient(users=[], cats=[])

    counts = await _refresh_target(session, "WP", client, NOW)  # type: ignore[arg-type]

    assert counts == (0, 0)
    # An empty upstream still clears the stale rows, but issues no INSERT.
    assert [(_kind(s), _table(s)) for s in session.statements] == [
        ("Delete", "wp_users"),
        ("Delete", "wp_categories"),
    ]


async def test_run_targets_skips_failing_target_and_keeps_others() -> None:
    session = _RecordingSession()
    ok = _FakeClient(users=[_Entity(1, "Ed", "ed")], cats=[])
    broken = _FakeClient(users=[], cats=[], fail=True)
    specs = [("WP", ok), ("VHIS101_WP", broken)]

    rc = await _run_targets(session, specs, NOW)  # type: ignore[arg-type]

    assert rc == 2  # at least one target failed upstream
    # Only the healthy target wrote anything (clear+insert users, clear cats);
    # the failing target raised before any statement, so it's fully skipped.
    rows = [r for s in session.statements if _kind(s) == "Insert" for r in _inserted_rows(s)]
    assert {r["auth_ref"] for r in rows} == {"WP"}
    assert not any(r["auth_ref"] == "VHIS101_WP" for r in rows)


async def test_run_targets_returns_zero_when_all_succeed() -> None:
    session = _RecordingSession()
    specs = [
        ("WP", _FakeClient(users=[_Entity(1, "Ed", "ed")], cats=[])),
        ("VHIS101_WP", _FakeClient(users=[_Entity(9, "Mei", "mei")], cats=[])),
    ]

    rc = await _run_targets(session, specs, NOW)  # type: ignore[arg-type]

    assert rc == 0
    inserted_auth_refs = {
        r["auth_ref"]
        for s in session.statements
        if _kind(s) == "Insert"
        for r in _inserted_rows(s)
    }
    assert inserted_auth_refs == {"WP", "VHIS101_WP"}
