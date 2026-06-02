"""Truncation / abnormal-finish detection + agent attribution for structured
Gemini replies.

When Gemini hits MAX_TOKENS (long article) or a SAFETY/RECITATION block, the
body is incomplete/empty JSON. The old path fed that straight into
parse_gemini_json, which raised a misleading bare "not valid JSON" ValueError
with no agent attribution — surfacing downstream (e.g. at publish in create
runs) as a confusing "broken JSON" error. parse_structured_response parses
first, then on failure uses finish_reason to raise a clear, attributed,
NON-transient GeminiError.

Mirrors deploy/cloudflare-workers/src/gemini/structured.test.ts.
"""

import pytest

from content_tool.gemini.client import GeminiError, parse_structured_response

TRUNCATED = '{"diagnose": "ok", "markup": "# H1\\n\\nsome '  # cut off mid-string


def test_valid_json_stop_returns_parsed():
    assert parse_structured_response("writer", '{"ok": true}', "STOP") == {"ok": True}


def test_valid_json_none_finish_reason_returns_parsed():
    # Existing one-shot/stream paths report finish_reason=None on success.
    assert parse_structured_response("writer", '{"ok": true}', None) == {"ok": True}


def test_max_tokens_truncation_raises_clear_attributed_error():
    with pytest.raises(GeminiError) as exc:
        parse_structured_response("writer", TRUNCATED, "MAX_TOKENS")
    msg = str(exc.value)
    assert "writer" in msg
    assert "MAX_TOKENS" in msg
    assert "truncated" in msg.lower() or "incomplete" in msg.lower()


def test_safety_block_raises_clear_attributed_error():
    with pytest.raises(GeminiError) as exc:
        parse_structured_response("audit", "", "SAFETY")
    msg = str(exc.value)
    assert "audit" in msg
    assert "SAFETY" in msg


def test_invalid_json_stop_attributes_parse_error_to_agent():
    # finish_reason is normal (STOP) but body is junk → still a GeminiError,
    # attributed to the agent, not a bare ValueError.
    with pytest.raises(GeminiError) as exc:
        parse_structured_response("outline", "not json at all", "STOP")
    assert "outline" in str(exc.value)


def test_invalid_json_none_finish_reason_attributes_to_agent():
    with pytest.raises(GeminiError) as exc:
        parse_structured_response("gap_analysis", "garbage", None)
    assert "gap_analysis" in str(exc.value)


def test_valid_json_with_max_tokens_does_not_false_raise():
    # Rare: model completed the object then hit the cap on trailing tokens.
    # Parse-first means a valid body still succeeds — no false truncation error.
    assert parse_structured_response("writer", '{"ok": true}', "MAX_TOKENS") == {"ok": True}
