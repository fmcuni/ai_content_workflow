# ruff: noqa: RUF001
import pytest

from content_tool.agents.render_html import render_html

SAMPLE = """\
# 大腸癌：症狀、篩查、治療與保險指南（2026）
%%meta desc=了解大腸癌的早期症狀、篩查方法。%%

大腸癌是香港常見的癌症之一。

%%adv_panel id=1%%

## 大腸癌篩查方法

大便潛血測試是常見的初步篩查方法。

%%page_widget id=2%%

## 常見問題
%%acf_faq type=q%%
篩查資格是什麼？
%%acf_faq type=a%%
50 至 75 歲香港居民。
%%end%%
%%acf_faq type=q%%
大腸癌可以根治嗎？
%%acf_faq type=a%%
若早期發現，治癒率高。
%%end%%

## 資訊來源
1. [www.ia.org.hk](https://www.ia.org.hk/x)
"""


def test_extracts_seo_title_and_meta():
    r = render_html(SAMPLE)
    assert r.seo_title == "大腸癌：症狀、篩查、治療與保險指南（2026）"
    assert r.meta_description == "了解大腸癌的早期症狀、篩查方法。"


def test_strips_h1_from_body():
    r = render_html(SAMPLE)
    assert "<h1>" not in r.html_body


def test_shortcodes_passthrough():
    r = render_html(SAMPLE)
    assert '[adv_panel id="1"]' in r.html_body
    assert '[page_widget id="2"]' in r.html_body


def test_faq_widget_html_first_active():
    r = render_html(SAMPLE)
    assert 'class="editor__item editor__faq"' in r.html_body
    assert 'class="e-faq__list is--active"' in r.html_body
    # First answer body has inline display:block
    assert 'style="display: block;"' in r.html_body


def test_jsonld_present_at_top():
    r = render_html(SAMPLE)
    assert r.html_body.startswith('<script type="application/ld+json">')
    assert r.faq_schema_jsonld is not None
    assert r.faq_schema_jsonld["@type"] == "FAQPage"
    assert len(r.faq_schema_jsonld["mainEntity"]) == 2


def test_sources_become_ol():
    r = render_html(SAMPLE)
    assert "<h2>資訊來源</h2>" in r.html_body
    assert "<ol>" in r.html_body
    assert '<a href="https://www.ia.org.hk/x">www.ia.org.hk</a>' in r.html_body


def test_no_raw_html_passthrough():
    bad = SAMPLE.replace("大腸癌是香港", "<script>alert(1)</script>大腸癌是香港")
    with pytest.raises(ValueError, match="sanitization"):
        render_html(bad)


def test_missing_h1_raises():
    with pytest.raises(ValueError, match="H1"):
        render_html("no H1 here\n%%meta desc=x%%\nbody\n")


def test_missing_meta_raises():
    with pytest.raises(ValueError, match="meta desc"):
        render_html("# Title\n\nbody without meta\n")


def test_no_faq_means_no_jsonld():
    no_faq = """\
# 標題
%%meta desc=說明%%

正文段落。

%%adv_panel id=1%%

## 章節
另一段。

%%page_widget id=2%%
"""
    r = render_html(no_faq)
    assert r.faq_schema_jsonld is None
    assert not r.html_body.startswith('<script type="application/ld+json">')


DEFTERM_SAMPLE = """\
# 妊娠糖尿病指南
%%meta desc=妊娠糖尿病解說%%

孕婦會在 24–28 週接受 OGTT 篩查。
%%defterm name=OGTT%%
口服葡萄糖耐量測試，飲糖水後 2 小時抽血評估血糖反應。
%%end%%

%%adv_panel id=1%%

## 自願醫保如何配合

VHIS 是政府自願醫保計劃。
%%defterm name=VHIS%%
自願醫保計劃，由食衞局監管的標準個人醫療保險產品。
%%end%%

%%defterm name=OGTT%%
這條會被去重，不應出現在 JSON-LD。
%%end%%

%%page_widget id=2%%

## 常見問題
%%acf_faq type=q%%
甚麼時候要做 OGTT？
%%acf_faq type=a%%
24 至 28 週。
%%end%%
"""


def test_defterm_emits_jsonld_and_strips_shortcode():
    r = render_html(DEFTERM_SAMPLE)
    # Shortcode must not survive into visible HTML
    assert "%%defterm" not in r.html_body
    assert "%%end%%" not in r.html_body
    # Both FAQ + DefinedTermSet scripts present
    scripts = [
        line for line in r.html_body.split("\n") if line.startswith("<script type=")
    ]
    assert len(scripts) == 2
    # DefinedTermSet payload: dedup'd, ordered by first occurrence
    assert '"@type": "DefinedTermSet"' in r.html_body
    assert '"name": "OGTT"' in r.html_body
    assert '"name": "VHIS"' in r.html_body
    assert r.html_body.count('"@type": "DefinedTerm"') == 2
    assert r.html_body.index('"OGTT"') < r.html_body.index('"VHIS"')


def test_defterm_absent_means_no_definedtermset():
    r = render_html(SAMPLE)  # SAMPLE has no defterm blocks
    assert "DefinedTermSet" not in r.html_body
