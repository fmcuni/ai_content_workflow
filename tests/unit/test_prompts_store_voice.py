"""Unit tests for per-voice prompt resolution in :mod:`content_tool.prompts_store`.

These exercise the pure, in-memory resolution helpers (no DB): include
resolution within a voice, the ``voice -> __shared__ -> bundled file`` fallback
chain, and that judges (only ever seeded under ``__shared__``) resolve for any
voice via the shared fallback.
"""

from __future__ import annotations

import pytest

from content_tool import prompts_store
from content_tool.prompts_store import (
    SHARED_VOICE,
    PromptTemplateNotFound,
    TemplateRow,
)


def _row(voice: str, tid: str, body: str, category: str = "agent") -> TemplateRow:
    return TemplateRow(
        voice_slug=voice,
        template_id=tid,
        category=category,
        filename=f"{tid}.md",
        body=body,
        sha256="x",
        bytes=len(body.encode("utf-8")),
    )


def _snap(*rows: TemplateRow) -> dict[tuple[str, str], TemplateRow]:
    return {(r.voice_slug, r.template_id): r for r in rows}


def test_includes_resolve_within_voice() -> None:
    # Same partial id exists under the voice AND under __shared__; the voice's
    # own partial must win.
    snap = _snap(
        _row("v1", "agent_x", "HEAD\n{{include:_p}}\nTAIL"),
        _row("v1", "_p", "VOICE-PARTIAL\n", category="partial"),
        _row(SHARED_VOICE, "_p", "SHARED-PARTIAL\n", category="partial"),
    )
    assembled = prompts_store.assemble_from_snapshot("agent_x", snap, voice_slug="v1")
    assert assembled == "HEAD\nVOICE-PARTIAL\nTAIL"


def test_template_falls_back_to_shared_when_voice_missing() -> None:
    # v2 has NO row for writer_x; it must resolve from __shared__.
    snap = _snap(_row(SHARED_VOICE, "writer_x", "SHARED-BODY"))
    assembled = prompts_store.assemble_from_snapshot("writer_x", snap, voice_slug="v2")
    assert assembled == "SHARED-BODY"


def test_partial_falls_back_to_shared_inside_include() -> None:
    # The voice owns the agent prompt but NOT the partial it includes; the
    # partial must fall back to __shared__.
    snap = _snap(
        _row("v1", "agent_x", "A {{include:_only_shared}} B"),
        _row(SHARED_VOICE, "_only_shared", "SHARED\n", category="partial"),
    )
    assembled = prompts_store.assemble_from_snapshot("agent_x", snap, voice_slug="v1")
    assert assembled == "A SHARED B"


def test_judge_resolves_shared_for_any_voice() -> None:
    # Judges are only ever seeded under __shared__; a voice with no judge row
    # resolves the shared judge via the fallback chain.
    snap = _snap(_row(SHARED_VOICE, "judge_brand_voice", "JUDGE", category="judge"))
    assembled = prompts_store.assemble_from_snapshot(
        "judge_brand_voice", snap, voice_slug="some-voice"
    )
    assert assembled == "JUDGE"


def test_file_fallback_when_no_row(tmp_path: pytest.TempPathFactory) -> None:
    # An empty snapshot falls through to the bundled prompts/*.md file.
    # 'outline_rewrite_mode' ships as prompts/outline_rewrite_mode.md, so the
    # assembled body must be non-empty and contain the template's known placeholder.
    snap: dict[tuple[str, str], TemplateRow] = {}
    assembled = prompts_store.assemble_from_snapshot(
        "outline_rewrite_mode", snap, voice_slug="v1"
    )
    assert "{today_date}" in assembled


def test_missing_everywhere_raises() -> None:
    snap: dict[tuple[str, str], TemplateRow] = {}
    with pytest.raises(PromptTemplateNotFound):
        prompts_store.assemble_from_snapshot("does_not_exist_anywhere", snap, voice_slug="v1")


def test_include_cycle_raises() -> None:
    snap = _snap(
        _row("v1", "_a", "{{include:_b}}", category="partial"),
        _row("v1", "_b", "{{include:_a}}", category="partial"),
    )
    with pytest.raises(ValueError, match="include cycle"):
        prompts_store.resolve_body("{{include:_a}}", snap, voice_slug="v1")


# ---------------------------------------------------------------------------
# Multi-override assembly (assemble_with_overrides)
# ---------------------------------------------------------------------------


def test_multi_override_slots_multiple_partials() -> None:
    snap = _snap(
        _row("v1", "agent_x", "{{include:_p1}}\n{{include:_p2}}\n"),
        _row("v1", "_p1", "stored p1\n", category="partial"),
        _row("v1", "_p2", "stored p2\n", category="partial"),
    )
    out = prompts_store.assemble_with_overrides(
        "agent_x",
        snap,
        {"_p1": "draft p1\n", "_p2": "draft p2\n"},
        voice_slug="v1",
    )
    assert out == "draft p1\ndraft p2\n"


def test_multi_override_resolves_nested_includes_via_map() -> None:
    # agent includes _p1; the _p1 DRAFT itself nests {{include:_p2}}, which is
    # also overridden — the nested include must resolve from the map.
    snap = _snap(
        _row("v1", "agent_x", "{{include:_p1}}\n"),
        _row("v1", "_p1", "stored p1\n", category="partial"),
        _row("v1", "_p2", "stored p2\n", category="partial"),
    )
    out = prompts_store.assemble_with_overrides(
        "agent_x",
        snap,
        {"_p1": "draft p1\n{{include:_p2}}\n", "_p2": "draft p2\n"},
        voice_slug="v1",
    )
    assert out == "draft p1\ndraft p2\n"


def test_multi_override_body_wins_over_stored() -> None:
    snap = _snap(
        _row("v1", "agent_x", "{{include:_p1}}\n"),
        _row("v1", "_p1", "stored p1\n", category="partial"),
    )
    out = prompts_store.assemble_with_overrides(
        "agent_x", snap, {"_p1": "draft wins\n"}, voice_slug="v1"
    )
    assert out == "draft wins\n"


def test_multi_override_empty_map_equals_stored_assembly() -> None:
    snap = _snap(
        _row("v1", "agent_x", "HEAD\n{{include:_p1}}\nTAIL\n"),
        _row("v1", "_p1", "stored p1\n", category="partial"),
    )
    with_empty = prompts_store.assemble_with_overrides("agent_x", snap, {}, voice_slug="v1")
    stored = prompts_store.assemble_from_snapshot("agent_x", snap, voice_slug="v1")
    assert with_empty == stored == "HEAD\nstored p1\nTAIL\n"


def test_single_override_shim_delegates_to_multi() -> None:
    snap = _snap(
        _row("v1", "agent_x", "{{include:_p1}}\n"),
        _row("v1", "_p1", "stored p1\n", category="partial"),
    )
    via_shim = prompts_store.assemble_with_override(
        "agent_x", snap, override_name="_p1", override_body="draft p1\n", voice_slug="v1"
    )
    via_map = prompts_store.assemble_with_overrides(
        "agent_x", snap, {"_p1": "draft p1\n"}, voice_slug="v1"
    )
    assert via_shim == via_map == "draft p1\n"
