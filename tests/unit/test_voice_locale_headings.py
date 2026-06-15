# ruff: noqa: RUF001
"""B1 — sources/FAQ heading driven by VoiceLocale (the live bug fix).

Covers the three pure-function surfaces touched by workstream B1:
  - resolve_citations._sources_heading_for (configured heading wins)
  - render_html (faq_heading + sources_heading params)
  - audit_checks.run_deterministic_checks (sources <h2> gate)

The HK-ZH default path MUST stay byte-identical; a voice with an explicit
English locale must render English headings and PASS audit.
"""

from content_tool.agents.audit_checks import run_deterministic_checks
from content_tool.agents.render_html import render_html
from content_tool.agents.resolve_citations import _sources_heading_for

# A minimal, fully-conformant zh draft (model wrote its own FAQ heading).
_ZH_MD = """\
# 大腸癌篩查指南
%%meta desc=了解大腸癌篩查。%%

大腸癌是香港常見的癌症之一。

%%adv_panel id=1%%

%%page_widget id=2%%

## 常見問題
%%acf_faq type=q%%
篩查資格是什麼？
%%acf_faq type=a%%
50 至 75 歲香港居民。
%%end%%

## 資訊來源
1. [www.ia.org.hk](https://www.ia.org.hk/x)
"""

# Same shape but an English voice: model wrote an English FAQ heading and the
# sources section uses the configured English heading.
_EN_MD = """\
# Colorectal Cancer Screening Guide
%%meta desc=Learn about colorectal cancer screening.%%

Colorectal cancer is common in Malaysia.

%%adv_panel id=1%%

%%page_widget id=2%%

## Frequently Asked Questions
%%acf_faq type=q%%
Who is eligible?
%%acf_faq type=a%%
Residents aged 50 to 75.
%%end%%

## Sources
1. [www.moh.gov.my](https://www.moh.gov.my/x)
"""


# --- _sources_heading_for ----------------------------------------------------


def test_sources_heading_configured_wins_verbatim():
    # A non-Chinese voice's explicit heading is used regardless of markup script.
    assert _sources_heading_for("anything 隨便", configured="Sources") == "Sources"


def test_sources_heading_none_keeps_traditional_detection():
    markup = "大腸癌是香港常見的癌症，這個篩查方法與保險條款有關。"
    assert _sources_heading_for(markup, configured=None) == "資訊來源"


def test_sources_heading_none_keeps_simplified_detection():
    markup = "大肠癌是常见的癌症，这个筛查方法与保险条款有关。"
    assert _sources_heading_for(markup, configured=None) == "资讯来源"


def test_sources_heading_default_arg_is_none_byte_identical():
    # Calling with NO configured arg must equal the old positional-only call.
    markup = "大腸癌是香港常見的癌症。"
    assert _sources_heading_for(markup) == "資訊來源"


# --- render_html: default (HK-ZH) path byte-identical -------------------------


def test_render_html_default_path_zh_unchanged():
    # No locale args → byte-identical to the pre-change render.
    result = render_html(_ZH_MD)
    assert "<h2>常見問題</h2>" in result.html_body
    assert "資訊來源" in result.html_body
    assert "Sources" not in result.html_body


def test_render_html_default_faq_fallback_is_traditional():
    # Strip the model's own FAQ heading → fallback must be 常見問題.
    md = _ZH_MD.replace("## 常見問題\n", "")
    result = render_html(md)
    assert "<h2>常見問題</h2>" in result.html_body


# --- render_html: English voice ----------------------------------------------


def test_render_html_english_sources_split_and_faq_fallback():
    # Strip the model's FAQ heading so the configured fallback is exercised.
    md = _EN_MD.replace("## Frequently Asked Questions\n", "")
    result = render_html(
        md,
        faq_heading="Frequently Asked Questions",
        sources_heading="Sources",
    )
    assert "<h2>Frequently Asked Questions</h2>" in result.html_body
    # The sources section was split off + re-injected after the FAQ widget.
    assert "<h2>Sources</h2>" in result.html_body
    assert "www.moh.gov.my" in result.html_body
    # No Traditional-Chinese scaffolding leaked in.
    assert "資訊來源" not in result.html_body
    assert "常見問題" not in result.html_body


def test_render_html_english_sources_split_recognises_configured_heading():
    # With sources_heading set, the Chinese-only split must NOT fire; the English
    # heading is what gets recognised + moved after the FAQ.
    result = render_html(
        _EN_MD,
        faq_heading="Frequently Asked Questions",
        sources_heading="Sources",
    )
    body = result.html_body
    # Sources <h2> appears AFTER the FAQ widget div (re-ordered, as for zh).
    assert body.index('class="editor__item editor__faq"') < body.index("<h2>Sources</h2>")


# --- audit_checks: sources <h2> gate -----------------------------------------

_ZH_AUDIT_HTML = (
    '<p>Intro.</p>\n[adv_panel id="1"]\n[page_widget id="2"]\n'
    '<div class="editor__item editor__faq"></div>\n<h2>資訊來源</h2>'
)
_EN_AUDIT_HTML = (
    '<p>Intro.</p>\n[adv_panel id="1"]\n[page_widget id="2"]\n'
    '<div class="editor__item editor__faq"></div>\n<h2>Sources</h2>'
)
_FAQPAGE = [{"@context": "https://schema.org", "@type": "FAQPage"}]


def test_audit_default_accepts_both_chinese_scripts():
    # Default (sources_heading=None) → no det-fmt-sources finding for zh.
    findings = run_deterministic_checks(
        _ZH_AUDIT_HTML, citations_denied_displayed=False, schema_jsonld=_FAQPAGE
    )
    assert not any(f["id"] == "det-fmt-sources" for f in findings)
    simplified = _ZH_AUDIT_HTML.replace("<h2>資訊來源</h2>", "<h2>资讯来源</h2>")
    findings = run_deterministic_checks(
        simplified, citations_denied_displayed=False, schema_jsonld=_FAQPAGE
    )
    assert not any(f["id"] == "det-fmt-sources" for f in findings)


def test_audit_english_passes_with_configured_heading():
    findings = run_deterministic_checks(
        _EN_AUDIT_HTML,
        citations_denied_displayed=False,
        schema_jsonld=_FAQPAGE,
        sources_heading="Sources",
    )
    assert findings == []


def test_audit_english_flags_when_chinese_heading_present_but_english_configured():
    # A zh heading on an English voice IS a finding (mismatch detected).
    findings = run_deterministic_checks(
        _ZH_AUDIT_HTML,
        citations_denied_displayed=False,
        schema_jsonld=_FAQPAGE,
        sources_heading="Sources",
    )
    assert any(f["id"] == "det-fmt-sources" for f in findings)
