import json

import pytest

from content_tool.gemini.client import (
    GeminiError,
    is_transient_gemini_error,
    with_gemini_retry,
)

NO_BACKOFF = (0.0, 0.0)


def test_json_decode_error_is_transient():
    try:
        json.loads("")
    except json.JSONDecodeError as e:
        assert is_transient_gemini_error(e) is True


def test_network_and_5xx_markers_are_transient():
    assert is_transient_gemini_error(Exception("fetch failed")) is True
    assert is_transient_gemini_error(Exception("503 temporarily unavailable")) is True
    assert is_transient_gemini_error(Exception("connection reset")) is True


def test_deterministic_errors_are_not_transient():
    assert is_transient_gemini_error(Exception("400 INVALID_ARGUMENT: bad schema")) is False
    assert is_transient_gemini_error(ValueError("permission denied")) is False


@pytest.mark.asyncio
async def test_returns_immediately_on_success():
    calls = 0

    async def fn():
        nonlocal calls
        calls += 1
        return "ok"

    assert await with_gemini_retry(fn, NO_BACKOFF) == "ok"
    assert calls == 1


@pytest.mark.asyncio
async def test_retries_transient_then_succeeds():
    calls = 0

    async def fn():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise json.JSONDecodeError("Expecting value", "", 0)
        return "recovered"

    assert await with_gemini_retry(fn, NO_BACKOFF) == "recovered"
    assert calls == 2


@pytest.mark.asyncio
async def test_deterministic_error_propagates_without_retry():
    calls = 0

    async def fn():
        nonlocal calls
        calls += 1
        raise ValueError("400 INVALID_ARGUMENT")

    with pytest.raises(ValueError, match="INVALID_ARGUMENT"):
        await with_gemini_retry(fn, NO_BACKOFF)
    assert calls == 1


@pytest.mark.asyncio
async def test_rewraps_into_gemini_error_after_exhausting_attempts():
    calls = 0

    async def fn():
        nonlocal calls
        calls += 1
        raise json.JSONDecodeError("Expecting value", "", 0)

    with pytest.raises(GeminiError):
        await with_gemini_retry(fn, NO_BACKOFF)
    assert calls == 3  # GEMINI_MAX_ATTEMPTS
