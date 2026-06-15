"""`_stored_locale` resolves a voice's locale for the preview/schema surfaces
(DB-first with YAML fallback), and the topic_hot user-prompt reference carries a
`{market}` token (filled from that locale by the /schema endpoint).

DB-free: a fake session whose ``execute`` returns no row forces the YAML
fallback, which reaches the bundled ``bowtie-editor.yaml`` (no ``locale`` key →
HK-ZH defaults).
"""

from typing import Any

from content_tool.api.routes.prompts import _USER_PROMPT_REFERENCES, _stored_locale


class _FakeResult:
    def scalar_one_or_none(self) -> None:
        return None


class _FakeSession:
    """Minimal async session: every SELECT misses → YAML fallback path."""

    async def execute(self, *_args: Any, **_kwargs: Any) -> _FakeResult:
        return _FakeResult()


async def test_stored_locale_falls_back_to_default_voice_hk_defaults() -> None:
    # An unknown voice with no DB row and no YAML file falls through to the
    # default voice (bowtie-editor.yaml → HK-ZH defaults).
    locale = await _stored_locale("ghost-voice", session=_FakeSession())  # type: ignore[arg-type]
    assert locale.brand_name == "Bowtie"
    assert locale.market == "Google 香港繁中"
    assert locale.output_language == "香港繁體中文"


def test_topic_hot_reference_uses_market_token() -> None:
    ref = _USER_PROMPT_REFERENCES["topic_hot"]
    assert "{market}" in ref
    # The hardcoded HK market literal is gone — it is now resolved per voice.
    assert "Google 香港繁中" not in ref
