"""Phase A foundation: VoiceLocale defaults reproduce HK-ZH (bowtie-editor).

Pure-model tests (no DB) — assert that an empty/absent ``personas.locale`` is a
no-op: every field falls back to the current Bowtie HK 繁體中文 behaviour, and a
PersonaPack built without a locale carries those same defaults.
"""

from content_tool.models.persona import PersonaPack, VoiceLocale

# The literals the rest of the pipeline must keep producing for HK-ZH voices.
HK_ZH_OUTPUT_LANGUAGE = "香港繁體中文"
HK_ZH_BRAND = "Bowtie"
HK_ZH_MARKET = "Google 香港繁中"
HK_ZH_FAQ_HEADING = "常見問題"


def test_default_locale_reproduces_hk_zh() -> None:
    loc = VoiceLocale()
    assert loc.output_language == HK_ZH_OUTPUT_LANGUAGE
    assert loc.brand_name == HK_ZH_BRAND
    assert loc.market == HK_ZH_MARKET
    assert loc.sources_heading is None  # → keeps script auto-detection
    assert loc.faq_heading == HK_ZH_FAQ_HEADING


def test_from_raw_none_and_empty_are_defaults() -> None:
    assert VoiceLocale.from_raw(None) == VoiceLocale()
    assert VoiceLocale.from_raw({}) == VoiceLocale()


def test_from_raw_partial_overrides_only_given_fields() -> None:
    loc = VoiceLocale.from_raw(
        {
            "output_language": "English (Malaysia)",
            "brand_name": "Bowtie",
            "market": "Google Malaysia (gobowtie.com/my)",
            "sources_heading": "Sources",
            "faq_heading": "Frequently Asked Questions",
        }
    )
    assert loc.output_language == "English (Malaysia)"
    assert loc.sources_heading == "Sources"
    assert loc.faq_heading == "Frequently Asked Questions"


def test_personapack_without_locale_gets_hk_zh_defaults() -> None:
    pack = PersonaPack.model_validate(
        {
            "name": "Bowtie 編輯",
            "voice_rules": ["親切專業"],
            "banned_terms": ["信息"],
            "required_phrasings": ["保障"],
            "disclaimer_templates": {},
            "tone_examples": {"good": [], "bad": []},
        }
    )
    assert pack.locale == VoiceLocale()
    assert pack.locale.sources_heading is None
