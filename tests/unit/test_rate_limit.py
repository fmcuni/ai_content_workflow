"""Unit tests for request throttling + error-leak hardening (DB-free, offline).

Covers:
- ``editor_identity_key`` bucketing (authenticated editor email vs client IP).
- The app factory wires ``app.state.limiter`` and registers a
  ``RateLimitExceeded`` exception handler.
- The 429 handler returns a 429 with a ``Retry-After`` header and a generic
  body (no internal detail leakage).

These are intentionally hermetic: no DB, no testcontainers, no network.
"""

from typing import Any
from unittest.mock import MagicMock

from fastapi import Request
from limits import parse
from slowapi.errors import RateLimitExceeded
from slowapi.wrappers import Limit

from content_tool.api.rate_limit import (
    RUN_CREATE_LIMIT,
    RUN_MUTATION_LIMIT,
    editor_identity_key,
    limiter,
    rate_limit_exceeded_handler,
)


def _make_request(headers: dict[str, str], client_host: str = "203.0.113.7") -> Request:
    """Build a minimal ASGI ``Request`` with the given headers + client host."""
    raw_headers = [
        (k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()
    ]
    scope: dict[str, Any] = {
        "type": "http",
        "method": "POST",
        "path": "/runs",
        "headers": raw_headers,
        "client": (client_host, 12345),
    }
    return Request(scope)


def test_editor_identity_key_uses_lowercased_editor_email() -> None:
    # Arrange
    request = _make_request({"X-Editor-Email": "Franco.MA@Bowtie.com.HK"})

    # Act
    key = editor_identity_key(request)

    # Assert
    assert key == "editor:franco.ma@bowtie.com.hk"


def test_editor_identity_key_strips_whitespace() -> None:
    request = _make_request({"X-Editor-Email": "  ops@bowtie.com  "})

    assert editor_identity_key(request) == "editor:ops@bowtie.com"


def test_editor_identity_key_falls_back_to_client_ip() -> None:
    # Arrange: no X-Editor-Email header present.
    request = _make_request({}, client_host="198.51.100.4")

    # Act
    key = editor_identity_key(request)

    # Assert
    assert key == "ip:198.51.100.4"


def test_editor_identity_key_blank_email_falls_back_to_ip() -> None:
    request = _make_request({"X-Editor-Email": "   "}, client_host="198.51.100.9")

    assert editor_identity_key(request) == "ip:198.51.100.9"


def test_limits_are_generous_string_caps() -> None:
    # Guard against an accidental edit that drops below interactive/test traffic.
    assert RUN_CREATE_LIMIT == "30/minute"
    assert RUN_MUTATION_LIMIT == "30/minute"


def test_app_factory_wires_limiter_and_handler() -> None:
    # Importing here keeps the module-level test collection DB-free; create_app
    # only constructs the FastAPI object (lifespan is not entered).
    from content_tool.api.main import create_app

    app = create_app()

    # Arrange/Act/Assert: limiter is the shared application-wide instance.
    assert app.state.limiter is limiter
    # A RateLimitExceeded handler is registered on the app.
    assert RateLimitExceeded in app.exception_handlers
    assert app.exception_handlers[RateLimitExceeded] is rate_limit_exceeded_handler


def test_429_handler_sets_retry_after_and_generic_body() -> None:
    # Arrange: a synthetic RateLimitExceeded plus the request-state the slowapi
    # header injector reads (view_rate_limit) and the shared app limiter.
    request = _make_request({"X-Editor-Email": "abuser@bowtie.com"})

    app = MagicMock()
    app.state.limiter = limiter
    request.scope["app"] = app

    # slowapi reads request.state.view_rate_limit when injecting headers; it is a
    # ``(RateLimitItem, [scope args])`` tuple. Build a real item via ``limits``.
    rate_item = parse(RUN_CREATE_LIMIT)
    request.state.view_rate_limit = (rate_item, [editor_identity_key(request)])

    # ``RateLimitExceeded`` wraps a slowapi ``Limit``; only ``.limit`` is read by
    # the handler's log line, so the other fields can be inert defaults.
    wrapped = Limit(
        limit=rate_item,
        key_func=editor_identity_key,
        scope=None,
        per_method=False,
        methods=None,
        error_message=None,
        exempt_when=None,
        cost=1,
        override_defaults=False,
    )
    exc = RateLimitExceeded(wrapped)

    # Act
    response = rate_limit_exceeded_handler(request, exc)

    # Assert
    assert response.status_code == 429
    assert "retry-after" in {k.lower() for k in response.headers}
    body = bytes(response.body)
    assert b"Rate limit exceeded" in body
    # No raw limiter internals / stack detail leaks into the response body.
    assert b"Traceback" not in body
    assert b"slowapi" not in body
