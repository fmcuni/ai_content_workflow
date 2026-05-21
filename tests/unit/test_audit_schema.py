import json
from pathlib import Path

from content_tool.models.audit import AuditOutput


def test_pass_blocking_is_false():
    data = json.loads(
        Path("tests/fixtures/gemini_responses/audit_pass.json").read_text(encoding="utf-8")
    )
    a = AuditOutput.model_validate(data)
    assert a.overall_pass
    assert not a.has_blocking()


def test_fail_blocking_is_true():
    data = json.loads(
        Path("tests/fixtures/gemini_responses/audit_fail.json").read_text(encoding="utf-8")
    )
    a = AuditOutput.model_validate(data)
    assert not a.overall_pass
    assert a.has_blocking()
