"""Guards the outline assembler's locale-token contract (Phase B3 + integration).

The outline templates were tokenized ({output_language}/{brand_name}/{market})
and ``outline.build_system_prompt`` interpolates them from the run's
``VoiceLocale`` (mirror of ``writer.build_system_prompt``). These DB-free checks
assert:
  - the shared outline templates DO carry the language token (so the reseed +
    runtime replace path is exercised), and
  - applying the HK-ZH default locale restores the exact pre-token literal
    (byte-identical no-op), while an English locale flows English through with
    no residual tokens and no leaked Traditional-Chinese language label.
"""

from pathlib import Path

from content_tool.models.persona import VoiceLocale

_PROMPTS = Path(__file__).resolve().parents[2] / "prompts"
_OUTLINE_FILES = ("outline_create_mode.md", "outline_rewrite_mode.md")
_TOKENS = ("{output_language}", "{brand_name}", "{market}")


def _apply(text: str, loc: VoiceLocale) -> str:
    return (
        text.replace("{brand_name}", loc.brand_name)
        .replace("{output_language}", loc.output_language)
        .replace("{market}", loc.market)
    )


def test_outline_templates_carry_language_token() -> None:
    for name in _OUTLINE_FILES:
        body = (_PROMPTS / name).read_text(encoding="utf-8")
        assert "{output_language}" in body, (
            f"{name} must keep the {{output_language}} token so non-HK voices "
            "get their language after the __shared__ reseed."
        )


def test_hk_default_locale_restores_pretoken_literal() -> None:
    # HK-ZH defaults must reproduce the original literals exactly (no-op) and
    # leave NO unresolved tokens behind.
    for name in _OUTLINE_FILES:
        body = (_PROMPTS / name).read_text(encoding="utf-8")
        rendered = _apply(body, VoiceLocale())
        assert "香港繁體中文" in rendered
        for tok in _TOKENS:
            assert tok not in rendered, f"{name}: unresolved {tok} after HK replace"


def test_english_locale_flows_through_outline_templates() -> None:
    loc = VoiceLocale.from_raw(
        {"output_language": "English (Malaysia)", "brand_name": "Bowtie"}
    )
    body = (_PROMPTS / "outline_create_mode.md").read_text(encoding="utf-8")
    rendered = _apply(body, loc)
    assert "English (Malaysia)" in rendered
    assert "{output_language}" not in rendered
    # The language label must be English now — no leaked Traditional-Chinese
    # "使用香港繁體中文" style instruction from the token position.
    assert "使用香港繁體中文" not in rendered
