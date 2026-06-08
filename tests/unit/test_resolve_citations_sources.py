# ruff: noqa: RUF001
"""Pure-function tests for the auto-generated sources section: the script of the
heading must follow the article's own Chinese script (Traditional by default)."""

from content_tool.agents.resolve_citations import (
    _build_sources_md,
    _sources_heading_for,
)


def test_heading_defaults_to_traditional_for_traditional_article():
    markup = "大腸癌是香港常見的癌症，這個篩查方法與保險條款有關，醫療費用會因應而變。"
    assert _sources_heading_for(markup) == "資訊來源"


def test_heading_is_simplified_for_simplified_article():
    markup = "大肠癌是常见的癌症，这个筛查方法与保险条款有关，医疗费用会因应而变。"
    assert _sources_heading_for(markup) == "资讯来源"


def test_heading_defaults_to_traditional_when_no_signal():
    # No script-exclusive characters → keep existing (Traditional) behaviour.
    assert _sources_heading_for("ABC 123 ----") == "資訊來源"


def test_build_sources_md_empty_returns_blank():
    assert _build_sources_md([]) == ""


def test_build_sources_md_default_heading_is_traditional():
    md = _build_sources_md([("www.ia.org.hk", "https://www.ia.org.hk/x")])
    assert "## 資訊來源" in md
    assert "1. [www.ia.org.hk](https://www.ia.org.hk/x)" in md


def test_build_sources_md_honours_simplified_heading():
    md = _build_sources_md(
        [("www.example.gov.my", "https://www.example.gov.my/x")],
        heading="资讯来源",
    )
    assert "## 资讯来源" in md
    assert "資訊來源" not in md
