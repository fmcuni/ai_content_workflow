"""B3 — brand/language/market token byte-identity tests.

Proves the *logic* of `build_system_prompt`'s locale token substitution without
touching the DB: the tokenized (includes-resolved) template, after the three
`{brand_name}` / `{output_language}` / `{market}` replaces with the HK-ZH
`VoiceLocale` defaults, is byte-identical to the original (pre-tokenization)
resolved prompt. A non-default brand/language changes the assembled text.
"""

from pathlib import Path

import pytest

from content_tool.agents.writer import PROMPT_PATHS, resolve_includes
from content_tool.models.persona import VoiceLocale

# Captured BEFORE the literals were tokenized — the byte-for-byte HK-ZH baseline.
_FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
_ORIG_GOLDENS = _FIXTURES / "expected_writer_prompts_pretoken"


def _apply_locale(text: str, loc: VoiceLocale) -> str:
    """Mirror the three locale replaces from `build_system_prompt`."""
    return (
        text.replace("{brand_name}", loc.brand_name)
        .replace("{output_language}", loc.output_language)
        .replace("{market}", loc.market)
    )


@pytest.mark.parametrize(
    ("route", "golden_name"),
    [
        ("small_refresh", "writer_small_refresh.md"),
        ("full_rewrite", "writer_full_rewrite.md"),
        ("create", "writer_create.md"),
    ],
)
def test_hk_zh_defaults_are_byte_identical(route: str, golden_name: str) -> None:
    route_path = PROMPT_PATHS[route]
    resolved = resolve_includes(
        route_path.read_text(encoding="utf-8"),
        base=route_path.parent,
    )
    assembled = _apply_locale(resolved, VoiceLocale())
    original = (_ORIG_GOLDENS / golden_name).read_text(encoding="utf-8")
    assert assembled == original


@pytest.mark.parametrize(
    ("route", "golden_name"),
    [
        ("small_refresh", "writer_small_refresh.md"),
        ("full_rewrite", "writer_full_rewrite.md"),
        ("create", "writer_create.md"),
    ],
)
def test_templates_carry_locale_tokens(route: str, golden_name: str) -> None:
    route_path = PROMPT_PATHS[route]
    resolved = resolve_includes(
        route_path.read_text(encoding="utf-8"),
        base=route_path.parent,
    )
    # The literals must have been swapped for tokens in the source files.
    assert "{brand_name}" in resolved
    assert "{output_language}" in resolved


def test_non_default_locale_changes_assembled_text() -> None:
    route_path = PROMPT_PATHS["create"]
    resolved = resolve_includes(
        route_path.read_text(encoding="utf-8"),
        base=route_path.parent,
    )
    loc = VoiceLocale(
        output_language="English (Malaysia)",
        brand_name="Acme",
        market="Google Malaysia",
    )
    assembled = _apply_locale(resolved, loc)
    assert "English (Malaysia)" in assembled
    assert "Acme" in assembled
    assert "Bowtie" not in assembled
    assert "香港繁體中文" not in assembled
