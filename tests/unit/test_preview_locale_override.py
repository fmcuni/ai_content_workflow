"""Phase B: locale override on POST /templates/:id/preview (Python mirror).

Pure-function tests (no DB): ``_substitute_placeholders`` with no
``locale_override`` is byte-identical to today (brand/lang/market/heading tokens
fall through); with an override it resolves them. A legacy retired ``ui_lang``
key on the request body is silently ignored (labels derive from output_language).
"""

from content_tool.api.routes.prompts import _PreviewRequest, _substitute_placeholders
from content_tool.models.persona import VoiceLocale

# Named-default tokens supplied via overrides so no DB lookup happens.
_BASE_OVERRIDES = {
    "persona_block": "PB",
    "today_date": "2026-06-15",
    "source_policy_block": "SP",
    "create_mode_block": "CM",
}

_TEMPLATE = "\n".join(
    [
        "{persona_block}",
        "date={today_date}",
        "policy={source_policy_block}",
        "create={create_mode_block}",
        "brand={brand_name}",
        "lang={output_language}",
        "market={market}",
        "faq={faq_heading}",
        "sources={sources_heading}",
    ]
)


def test_no_override_is_byte_identical_to_today() -> None:
    # ``view={}`` keeps create_mode_block resolution local; overrides supply the
    # rest so the function never touches the DB.
    out_without = _substitute_placeholders(
        _TEMPLATE, overrides=dict(_BASE_OVERRIDES), view={}
    )
    out_with_none = _substitute_placeholders(
        _TEMPLATE, overrides=dict(_BASE_OVERRIDES), view={}, locale_override=None
    )

    expected = "\n".join(
        [
            "PB",
            "date=2026-06-15",
            "policy=SP",
            "create=CM",
            # Locale tokens stay literal today — nothing substitutes them here.
            "brand={brand_name}",
            "lang={output_language}",
            "market={market}",
            "faq={faq_heading}",
            "sources={sources_heading}",
        ]
    )
    assert out_without == expected
    # Passing locale_override=None is identical to omitting it.
    assert out_with_none == out_without


def test_override_resolves_brand_lang_market_and_headings() -> None:
    locale = VoiceLocale.from_raw(
        {
            "output_language": "English (Malaysia)",
            "brand_name": "Bowtie MY",
            "market": "Google Malaysia (gobowtie.com/my)",
            "sources_heading": "Sources",
            "faq_heading": "Frequently Asked Questions",
        }
    )
    out = _substitute_placeholders(
        _TEMPLATE, overrides=dict(_BASE_OVERRIDES), view={}, locale_override=locale
    )

    assert "brand=Bowtie MY" in out
    assert "lang=English (Malaysia)" in out
    assert "market=Google Malaysia (gobowtie.com/my)" in out
    assert "faq=Frequently Asked Questions" in out
    assert "sources=Sources" in out
    # No raw locale tokens leak through once an override is applied.
    assert "{brand_name}" not in out
    assert "{output_language}" not in out
    assert "{market}" not in out
    assert "{faq_heading}" not in out


def test_override_null_sources_heading_substitutes_empty() -> None:
    locale = VoiceLocale.from_raw({"brand_name": "Acme"})
    out = _substitute_placeholders(
        "S={sources_heading}",
        overrides={"persona_block": "PB", "source_policy_block": "SP"},
        view={},
        locale_override=locale,
    )
    assert out == "S="


def test_partial_locale_accepted_and_legacy_ui_lang_ignored() -> None:
    # A legacy retired ``ui_lang`` key is silently ignored; other fields default.
    req = _PreviewRequest(template="x", locale={"ui_lang": "en", "brand_name": "Bowtie MY"})  # type: ignore[arg-type]
    assert req.locale is not None
    assert req.locale.brand_name == "Bowtie MY"
    assert not hasattr(req.locale, "ui_lang")
    # Omitted fields default (mirrors VoiceLocale.from_raw leniency).
    assert req.locale.output_language == "香港繁體中文"


def test_absent_locale_defaults_to_none() -> None:
    req = _PreviewRequest(template="x")
    assert req.locale is None
