import json
from pathlib import Path

from content_tool.models.outline import Outline


def test_outline_parses():
    fixture = Path("tests/fixtures/gemini_responses/outline_ok.json")
    data = json.loads(fixture.read_text(encoding="utf-8"))
    o = Outline.model_validate(data)
    assert o.h1.startswith("大腸癌")
    assert len(o.sections) == 3
    assert o.sections[2].action == "add"
    assert o.shortcode_positions.page_widget_before == "faq"
