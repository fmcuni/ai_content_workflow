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
