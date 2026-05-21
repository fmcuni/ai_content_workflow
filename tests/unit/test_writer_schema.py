import json
from pathlib import Path

from content_tool.models.writer import WriterOutput


def test_writer_output_parses():
    data = json.loads(
        Path("tests/fixtures/gemini_responses/writer_small_refresh_ok.json").read_text(
            encoding="utf-8"
        )
    )
    out = WriterOutput.model_validate(data)
    assert "%%adv_panel id=1%%" in out.markup
    assert len(out.citation_intents) == 2
