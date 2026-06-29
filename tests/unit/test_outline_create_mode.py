"""Guards the create/refresh outline template split.

Create-mode and refresh-mode now use independent templates: create resolves
``outline_create_mode`` directly and refresh resolves ``outline_rewrite_mode``.
The old ``{create_mode_block}`` injection seam is retired — the rewrite body
must no longer carry it (the branching wiring lives in
``content_tool/agents/outline.py::build_system_prompt``).
"""

from pathlib import Path

_PROMPTS = Path(__file__).resolve().parents[2] / "prompts"


def test_rewrite_template_no_longer_carries_create_mode_seam():
    text = (_PROMPTS / "outline_rewrite_mode.md").read_text(encoding="utf-8")
    assert "{create_mode_block}" not in text, (
        "outline_rewrite_mode.md must not contain the retired "
        "{create_mode_block} seam — create-mode uses outline_create_mode directly."
    )


def test_create_template_is_a_standalone_prompt():
    text = (_PROMPTS / "outline_create_mode.md").read_text(encoding="utf-8").strip()
    assert text, "outline_create_mode.md must be a non-empty standalone prompt."
    assert "{create_mode_block}" not in text
