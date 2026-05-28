from pathlib import Path

import pytest

from content_tool.agents.writer import PROMPT_PATHS, resolve_includes

_GOLDENS = Path(__file__).resolve().parents[1] / "fixtures" / "expected_writer_prompts"


@pytest.mark.parametrize(
    ("route", "golden_name"),
    [
        ("small_refresh", "writer_small_refresh.md"),
        ("full_rewrite", "writer_full_rewrite.md"),
        ("create", "writer_create.md"),
    ],
)
def test_route_file_resolves_to_golden(route: str, golden_name: str) -> None:
    route_path = PROMPT_PATHS[route]
    resolved = resolve_includes(
        route_path.read_text(encoding="utf-8"),
        base=route_path.parent,
    )
    expected = (_GOLDENS / golden_name).read_text(encoding="utf-8")
    assert resolved == expected


def test_include_cycle_raises(tmp_path: Path) -> None:
    (tmp_path / "_a.md").write_text("{{include:_b}}", encoding="utf-8")
    (tmp_path / "_b.md").write_text("{{include:_a}}", encoding="utf-8")
    with pytest.raises(ValueError, match="include cycle"):
        resolve_includes("{{include:_a}}", base=tmp_path)


def test_missing_partial_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        resolve_includes("{{include:_does_not_exist}}", base=tmp_path)


def test_resolver_is_noop_without_directives(tmp_path: Path) -> None:
    text = "no directives here\n## heading\nbody"
    assert resolve_includes(text, base=tmp_path) == text


def test_nested_includes_resolve(tmp_path: Path) -> None:
    (tmp_path / "_outer.md").write_text(
        "outer-start {{include:_inner}} outer-end\n", encoding="utf-8"
    )
    (tmp_path / "_inner.md").write_text("INNER\n", encoding="utf-8")
    assert resolve_includes("before {{include:_outer}} after", base=tmp_path) == (
        "before outer-start INNER outer-end after"
    )
