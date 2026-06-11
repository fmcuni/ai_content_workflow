"""Unit tests for the audit user prompt assembly (edit_note section)."""

from content_tool.agents.audit import build_user_prompt


def _build(edit_note: str | None) -> str:
    return build_user_prompt(
        html_body="<p>body</p>",
        gap_update_plan={"must_add": []},
        citation_intents=[{"claim": "c1"}],
        citations_summary=[{"domain": "ia.org.hk"}],
        deterministic_findings=[],
        edit_note=edit_note,
    )


def test_appends_edit_note_section_when_brief_present():
    prompt = _build("重點介紹醫然保\nhttps://example.com")
    assert prompt.endswith(
        "\n\n# edit_note (operator brief)\n重點介紹醫然保\nhttps://example.com"
    )
    assert prompt.startswith("# final_html\n<p>body</p>\n\n")
    assert "# deterministic_findings\n[]" in prompt


def test_omits_edit_note_section_when_brief_absent():
    for edit_note in (None, ""):
        prompt = _build(edit_note)
        assert "# edit_note" not in prompt
        assert prompt.endswith("# deterministic_findings\n[]")


def test_default_matches_pre_change_prompt_bytes():
    # Omitting edit_note must keep the prompt byte-identical to the old shape
    # (prompt-sha parity with historical drafts).
    no_kwarg = build_user_prompt(
        html_body="<p>body</p>",
        gap_update_plan={"must_add": []},
        citation_intents=[{"claim": "c1"}],
        citations_summary=[{"domain": "ia.org.hk"}],
        deterministic_findings=[],
    )
    assert no_kwarg == _build(None)
