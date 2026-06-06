"""DB-backed per-voice resolution tests for the prompt + source-policy stores.

Runs against the per-voice schema (``supabase db reset`` with the Phase 2
re-seed applied). Asserts:
  * assembled prompts are BYTE-IDENTICAL for ``bowtie-editor``, ``__shared__``,
    and the on-disk golden fixture (the per-voice change selects which row is
    read, never the assembly);
  * a voice with no row for a template resolves it from ``__shared__``;
  * the source policy resolves ``voice -> __shared__`` for a missing voice.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool import prompts_store, source_policy_store

_GOLDENS = Path(__file__).resolve().parents[1] / "fixtures" / "expected_writer_prompts"


@pytest_asyncio.fixture(autouse=True)
async def _bust_caches(apply_migrations):
    """Drop the per-process snapshots so each test reads the live DB."""
    prompts_store.clear_cache()
    source_policy_store.clear_cache()
    yield
    prompts_store.clear_cache()
    source_policy_store.clear_cache()


@pytest.mark.asyncio
async def test_writer_prompt_byte_identical_across_voice_and_shared(
    pg_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    golden = (_GOLDENS / "writer_small_refresh.md").read_text(encoding="utf-8")
    async with pg_session_factory() as session:
        for_editor = await prompts_store.get_assembled(
            "writer_small_refresh", voice_slug="bowtie-editor", session=session
        )
        for_shared = await prompts_store.get_assembled(
            "writer_small_refresh", voice_slug="__shared__", session=session
        )
    assert for_editor == golden
    assert for_shared == golden


@pytest.mark.asyncio
async def test_missing_voice_template_falls_back_to_shared(
    pg_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # 'ghost-voice' has no prompt_templates rows at all → resolves from __shared__.
    async with pg_session_factory() as session:
        ghost = await prompts_store.get_assembled(
            "writer_small_refresh", voice_slug="ghost-voice", session=session
        )
        shared = await prompts_store.get_assembled(
            "writer_small_refresh", voice_slug="__shared__", session=session
        )
    assert ghost == shared


@pytest.mark.asyncio
async def test_judge_resolves_shared_for_any_voice(
    pg_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Judges are only seeded under __shared__; any voice resolves them via fallback.
    async with pg_session_factory() as session:
        judged = await prompts_store.get_assembled(
            "judge_brand_voice", voice_slug="bowtie-editor", session=session
        )
        shared = await prompts_store.get_assembled(
            "judge_brand_voice", voice_slug="__shared__", session=session
        )
    assert judged == shared
    assert judged.strip() != ""


@pytest.mark.asyncio
async def test_source_policy_voice_falls_back_to_shared(
    pg_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with pg_session_factory() as session:
        editor = await source_policy_store.snapshot(
            voice_slug="bowtie-editor", session=session
        )
    source_policy_store.clear_cache()
    async with pg_session_factory() as session:
        ghost = await source_policy_store.snapshot(
            voice_slug="ghost-voice", session=session
        )
        shared = await source_policy_store.snapshot(
            voice_slug="__shared__", session=session
        )
    # bowtie-editor was backfilled from the shared seed → identical body.
    assert editor.body == shared.body
    # A voice with no policy row resolves the shared row.
    assert ghost.body == shared.body
