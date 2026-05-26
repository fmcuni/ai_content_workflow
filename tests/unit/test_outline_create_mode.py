"""Guards the substitution point for the outline create-mode swap.

Real branching wiring (refresh → "" / create → n8n Settings3 body) lives in
``content_tool/agents/outline.py`` and is added in Task 4. This test just
ensures the template carries exactly one ``{create_mode_block}`` token so the
later swap is unambiguous.
"""

from pathlib import Path


def test_outline_prompt_has_single_create_mode_token():
    outline_path = Path(__file__).resolve().parents[2] / "prompts" / "outline.md"
    text = outline_path.read_text(encoding="utf-8")
    assert text.count("{create_mode_block}") == 1, (
        "outline.md must declare exactly one {create_mode_block} substitution "
        "point so create/refresh swapping is unambiguous."
    )
    # Token must appear before the refresh-mode body (the "你會收到" block).
    token_idx = text.index("{create_mode_block}")
    body_idx = text.index("你會收到")
    assert token_idx < body_idx, (
        "{create_mode_block} must precede the refresh-mode instructions so "
        "create-mode runs see their full prompt body first."
    )
