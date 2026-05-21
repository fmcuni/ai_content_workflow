import json
from pathlib import Path

from content_tool.models.gap_analysis import GapAnalysis


def test_parses_valid_fixture():
    fixture = Path("tests/fixtures/gemini_responses/gap_analysis_ok.json")
    data = json.loads(fixture.read_text(encoding="utf-8"))
    ga = GapAnalysis.model_validate(data)
    assert ga.chosen_route == "small_refresh"
    assert len(ga.top_pages) == 5


def test_top_pages_must_be_exactly_5():
    fixture = Path("tests/fixtures/gemini_responses/gap_analysis_ok.json")
    data = json.loads(fixture.read_text(encoding="utf-8"))
    data["top_pages"] = data["top_pages"][:3]
    try:
        GapAnalysis.model_validate(data)
        assert False, "should have raised"
    except Exception as e:
        assert "5" in str(e) or "exactly 5" in str(e).lower() or "min" in str(e).lower()


def test_chosen_route_is_constrained():
    fixture = Path("tests/fixtures/gemini_responses/gap_analysis_ok.json")
    data = json.loads(fixture.read_text(encoding="utf-8"))
    data["chosen_route"] = "wat"
    try:
        GapAnalysis.model_validate(data)
        assert False, "should have raised"
    except Exception:
        pass
