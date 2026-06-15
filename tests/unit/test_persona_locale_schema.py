"""Unit tests for per-voice locale on the persona API schemas (Phase A).

These exercise the Pydantic boundary only (no DB): that ``PersonaIn`` /
``PersonaPatch`` accept the snake_case ``locale`` object, that ``PersonaOut``
emits it, that an omitted locale defaults to the HK-ZH no-op, and that a legacy
retired ``ui_lang`` key is silently ignored (labels derive from output_language).
"""

from datetime import UTC, datetime
from uuid import uuid4

from content_tool.api.schemas import PersonaIn, PersonaOut, PersonaPatch
from content_tool.models.persona import VoiceLocale

_LOCALE_MY_EN = {
    "output_language": "English",
    "brand_name": "Bowtie MY",
    "market": "Google Malaysia EN",
    "sources_heading": "Sources",
    "faq_heading": "Frequently Asked Questions",
}


def test_persona_patch_accepts_locale_snake_case() -> None:
    patch = PersonaPatch.model_validate({"locale": _LOCALE_MY_EN})
    assert patch.locale is not None
    assert patch.locale.output_language == "English"
    # Whole-object replace: model_dump round-trips back to snake_case JSONB.
    assert patch.model_dump(exclude_unset=True)["locale"] == _LOCALE_MY_EN


def test_persona_patch_omitted_locale_excluded_from_dump() -> None:
    """Omitted locale must not appear in the exclude_unset patch (column untouched)."""
    patch = PersonaPatch.model_validate({"name": "x"})
    assert patch.locale is None
    assert "locale" not in patch.model_dump(exclude_unset=True)


def test_persona_in_locale_defaults_to_hk_zh() -> None:
    payload = PersonaIn.model_validate({
        "slug": "test-voice",
        "name": "Test",
        "voice_rules": [],
        "banned_terms": [],
        "required_phrasings": [],
        "disclaimer_templates": {},
        "tone_examples": {"good": [], "bad": []},
    })
    # No locale supplied → HK-ZH defaults (byte-identical to bowtie-editor).
    assert payload.locale == VoiceLocale()
    assert payload.locale.faq_heading == "常見問題"


def test_persona_out_emits_locale_from_raw_jsonb() -> None:
    now = datetime.now(UTC)
    out = PersonaOut.model_validate({
        "persona_id": uuid4(),
        "slug": "bowtie-en-my",
        "name": "Bowtie MY EN",
        "voice_rules": [],
        "banned_terms": [],
        "required_phrasings": [],
        "disclaimer_templates": {},
        "tone_examples": {"good": [], "bad": []},
        "glossary": [],
        "locale": _LOCALE_MY_EN,
        "publish_target_id": None,
        "is_archived": False,
        "created_at": now,
        "updated_at": now,
        "created_by": None,
        "updated_by": None,
    })
    dumped = out.model_dump()
    assert dumped["locale"] == _LOCALE_MY_EN
    assert "ui_lang" not in dumped["locale"]


def test_persona_out_empty_locale_jsonb_yields_hk_zh_defaults() -> None:
    """An empty {} in the JSONB column → HK-ZH defaults on read (no-op)."""
    now = datetime.now(UTC)
    out = PersonaOut.model_validate({
        "persona_id": uuid4(),
        "slug": "bowtie-editor",
        "name": "Bowtie 編輯",
        "voice_rules": [],
        "banned_terms": [],
        "required_phrasings": [],
        "disclaimer_templates": {},
        "tone_examples": {"good": [], "bad": []},
        "glossary": [],
        "locale": {},
        "publish_target_id": None,
        "is_archived": False,
        "created_at": now,
        "updated_at": now,
        "created_by": None,
        "updated_by": None,
    })
    assert out.locale == VoiceLocale()


def test_persona_patch_ignores_legacy_ui_lang_key() -> None:
    # Backward-compat: a locale that still carries the retired ``ui_lang`` key is
    # accepted and the key is silently dropped (labels derive from output_language).
    legacy = {**_LOCALE_MY_EN, "ui_lang": "en"}
    patch = PersonaPatch.model_validate({"locale": legacy})
    assert patch.locale is not None
    assert "ui_lang" not in patch.model_dump(exclude_unset=True)["locale"]
