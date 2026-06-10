"""Unit tests for WS5 input validation on the run-creation request model.

These exercise ``CreateRunRequest`` (``content_tool.api.schemas``) — the
Pydantic model that carries the operator-supplied run inputs (article_url,
keywords, persona, start_mode, ...). Validation is format-level only and fully
offline: no DB, no DNS, no network. (The DNS/IP SSRF checks live in the runtime
``content_tool.net.url_guard.assert_url_is_safe`` and are NOT duplicated here.)
"""

import pytest
from pydantic import ValidationError

from content_tool.api.schemas import CreateRunRequest

# A minimal valid create-mode payload. create mode forbids article_url and the
# server generates it after the draft publish, so it is omitted here.
_CREATE_BASE: dict[str, object] = {
    "topic": "Critical illness cover explained",
    "keywords": ["critical illness", "insurance"],
    "acf_adv_id": 0,
    "acf_widget_id": 0,
    "editor_email": "editor@bowtie.com.hk",
    "start_mode": "create",
}

# A minimal valid refresh-mode payload. refresh mode REQUIRES article_url.
_REFRESH_BASE: dict[str, object] = {
    "article_url": "https://www.bowtie.com.hk/blog/some-article",
    "topic": "Critical illness cover explained",
    "keywords": ["critical illness"],
    "acf_adv_id": 0,
    "acf_widget_id": 0,
    "editor_email": "editor@bowtie.com.hk",
    "start_mode": "refresh",
}


# --- valid inputs still accepted (no regression for existing callers) ---------


def test_valid_create_mode_input_accepted():
    req = CreateRunRequest.model_validate(_CREATE_BASE)
    assert req.start_mode == "create"
    assert req.article_url is None
    assert req.persona == "bowtie-editor"  # default preserved


def test_valid_refresh_mode_input_accepted():
    req = CreateRunRequest.model_validate(_REFRESH_BASE)
    assert req.start_mode == "refresh"
    assert req.article_url == "https://www.bowtie.com.hk/blog/some-article"


def test_http_article_url_accepted():
    payload = {**_REFRESH_BASE, "article_url": "http://example.com/a"}
    req = CreateRunRequest.model_validate(payload)
    assert req.article_url == "http://example.com/a"


def test_empty_keywords_list_accepted():
    # An empty keyword list is below the cap and must stay valid.
    payload = {**_CREATE_BASE, "keywords": []}
    assert CreateRunRequest.model_validate(payload).keywords == []


def test_exactly_twenty_keywords_accepted():
    payload = {**_CREATE_BASE, "keywords": [f"kw{i}" for i in range(20)]}
    assert len(CreateRunRequest.model_validate(payload).keywords) == 20


# --- malformed inputs rejected ------------------------------------------------


@pytest.mark.parametrize(
    "bad_url",
    [
        "ftp://example.com/a",
        "file:///etc/passwd",
        "gopher://example.com",
        "javascript:alert(1)",
        "example.com/no-scheme",
    ],
)
def test_non_http_article_url_rejected(bad_url: str):
    payload = {**_REFRESH_BASE, "article_url": bad_url}
    with pytest.raises(ValidationError):
        CreateRunRequest.model_validate(payload)


def test_twenty_one_keywords_rejected():
    payload = {**_CREATE_BASE, "keywords": [f"kw{i}" for i in range(21)]}
    with pytest.raises(ValidationError):
        CreateRunRequest.model_validate(payload)


def test_bad_start_mode_rejected():
    payload = {**_CREATE_BASE, "start_mode": "bogus"}
    with pytest.raises(ValidationError):
        CreateRunRequest.model_validate(payload)


def test_bad_mode_rejected():
    payload = {**_CREATE_BASE, "mode": "turbo"}
    with pytest.raises(ValidationError):
        CreateRunRequest.model_validate(payload)
