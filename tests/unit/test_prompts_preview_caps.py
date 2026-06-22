"""Preview-endpoint resource caps (POST /templates/:id/preview).

Unit-tests the pure ``_enforce_preview_caps`` guard that bounds unsaved-draft
preview input before any DB work. Mirrors the Workers backend caps in
``deploy/cloudflare-workers/src/routes/prompts_preview_caps.test.ts``: 413 for
per-value byte-size excess, 422 for entry-count / per-string-length excess.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from content_tool.api.routes.prompts import (
    _MAX_TEMPLATE_BYTES,
    _enforce_preview_caps,
    _PreviewRequest,
)
from content_tool.models.persona import GlossaryEntry


def test_rejects_too_many_partial_overrides() -> None:
    overrides = {f"p{i}": "x" for i in range(101)}
    body = _PreviewRequest(template="x", partial_overrides=overrides)
    with pytest.raises(HTTPException) as exc:
        _enforce_preview_caps(body)
    assert exc.value.status_code == 422


def test_rejects_oversized_partial_override_value() -> None:
    overrides = {"p": "a" * (_MAX_TEMPLATE_BYTES + 1)}
    body = _PreviewRequest(template="x", partial_overrides=overrides)
    with pytest.raises(HTTPException) as exc:
        _enforce_preview_caps(body)
    assert exc.value.status_code == 413


def test_rejects_oversized_source_policy_prompt_block() -> None:
    policy = {"prompt_block": "a" * (_MAX_TEMPLATE_BYTES + 1)}
    body = _PreviewRequest(template="x", source_policy=policy)
    with pytest.raises(HTTPException) as exc:
        _enforce_preview_caps(body)
    assert exc.value.status_code == 413


def test_rejects_too_many_glossary_entries() -> None:
    glossary = [GlossaryEntry(term="t") for _ in range(501)]
    body = _PreviewRequest(template="x", glossary=glossary)
    with pytest.raises(HTTPException) as exc:
        _enforce_preview_caps(body)
    assert exc.value.status_code == 422


def test_rejects_overlong_glossary_field() -> None:
    glossary = [GlossaryEntry(term="a" * 501)]
    body = _PreviewRequest(template="x", glossary=glossary)
    with pytest.raises(HTTPException) as exc:
        _enforce_preview_caps(body)
    assert exc.value.status_code == 422


def test_accepts_input_at_the_limits() -> None:
    glossary = [GlossaryEntry(term="t", preferred="p") for _ in range(500)]
    overrides = {f"p{i}": "x" for i in range(100)}
    body = _PreviewRequest(template="x", partial_overrides=overrides, glossary=glossary)
    # No exception ⇒ in-bounds input passes the guard untouched.
    _enforce_preview_caps(body)
