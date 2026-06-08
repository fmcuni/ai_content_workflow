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


def test_faq_jsonld_not_in_body_but_in_schema_graph():
    """JSON-LD is delivered out-of-band (post meta → wp_head), never inlined
    into the body. The body must carry NO <script> block; the FAQPage piece
    lives in schema_jsonld instead."""
    r = render_html(SAMPLE)
    assert '<script type="application/ld+json">' not in r.html_body
    # Back-compat field still populated.
    assert r.faq_schema_jsonld is not None
    assert r.faq_schema_jsonld["@type"] == "FAQPage"
    assert len(r.faq_schema_jsonld["mainEntity"]) == 2
    # Out-of-band graph carries the FAQPage piece.
    assert r.schema_jsonld is not None
    faqpage = [p for p in r.schema_jsonld if p["@type"] == "FAQPage"]
    assert len(faqpage) == 1
    assert len(faqpage[0]["mainEntity"]) == 2


def test_sources_become_ol():
    r = render_html(SAMPLE)
    assert "<h2>資訊來源</h2>" in r.html_body
    assert "<ol>" in r.html_body
    assert '<a href="https://www.ia.org.hk/x">www.ia.org.hk</a>' in r.html_body


def test_no_raw_html_passthrough():
    bad = SAMPLE.replace("大腸癌是香港", "<script>alert(1)</script>大腸癌是香港")
    with pytest.raises(ValueError, match="sanitization"):
        render_html(bad)


def test_faq_heading_carried_through_traditional():
    """The Traditional voice still renders its hard-coded heading verbatim, so
    existing output stays byte-identical."""
    r = render_html(SAMPLE)
    assert "<h2>常見問題</h2>" in r.html_body


# A zh-MY (Simplified) voice writes its own Simplified FAQ heading, and the
# auto-generated sources section is emitted in Simplified by resolve_citations.
SAMPLE_ZH_MY = """\
# 大肠癌：症状、筛查、治疗与保险指南（2026）
%%meta desc=了解大肠癌的早期症状、筛查方法。%%

大肠癌是常见的癌症之一。

%%adv_panel id=1%%

## 大肠癌筛查方法

大便潜血测试是常见的初步筛查方法。

%%page_widget id=2%%

## 常见问题
%%acf_faq type=q%%
筛查资格是什么？
%%acf_faq type=a%%
50 至 75 岁居民。
%%end%%

## 资讯来源
1. [www.example.gov.my](https://www.example.gov.my/x)
"""


def test_faq_heading_not_duplicated_for_simplified_voice():
    """The model's Simplified heading is carried through and re-injected — NOT
    appended on top of a hard-coded Traditional one (the duplicate-heading bug)."""
    r = render_html(SAMPLE_ZH_MY)
    assert "<h2>常见问题</h2>" in r.html_body
    # The hard-coded Traditional heading must NOT appear alongside it.
    assert "常見問題" not in r.html_body
    assert r.html_body.count("常见问题") == 1
    assert 'class="editor__item editor__faq"' in r.html_body


def test_simplified_sources_section_rendered_and_reordered():
    r = render_html(SAMPLE_ZH_MY)
    assert "<h2>资讯来源</h2>" in r.html_body
    assert "資訊來源" not in r.html_body
    # Sources sit AFTER the FAQ widget.
    assert r.html_body.index("editor__faq") < r.html_body.index("资讯来源")


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
    assert '<script type="application/ld+json">' not in r.html_body
    # No FAQ and no defterm → empty graph collapses to None.
    assert r.schema_jsonld is None


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


def _defterm_piece(r):
    """The DefinedTermSet piece from the out-of-band schema graph, or None."""
    pieces = [p for p in (r.schema_jsonld or []) if p["@type"] == "DefinedTermSet"]
    return pieces[0] if pieces else None


def test_defterm_emits_jsonld_and_strips_shortcode():
    r = render_html(DEFTERM_SAMPLE)
    # Shortcode must not survive into visible HTML; no inline <script> either.
    assert "%%defterm" not in r.html_body
    assert "%%end%%" not in r.html_body
    assert '<script type="application/ld+json">' not in r.html_body
    # Graph carries both a FAQPage and a DefinedTermSet piece.
    assert r.schema_jsonld is not None
    types = [p["@type"] for p in r.schema_jsonld]
    assert "FAQPage" in types
    dts = _defterm_piece(r)
    assert dts is not None
    # DefinedTermSet payload: dedup'd, ordered by first occurrence.
    names = [t["name"] for t in dts["hasDefinedTerm"]]
    assert names == ["OGTT", "VHIS"]


def test_defterm_absent_means_no_definedtermset():
    r = render_html(SAMPLE)  # SAMPLE has no defterm blocks
    assert "DefinedTermSet" not in r.html_body
    assert _defterm_piece(r) is None


# Regression: the writer nests defterm / FAQ blocks inside markdown bullets,
# which prefixes every line with 2+ spaces. Earlier the regex required the
# closing tag to sit flush against the newline, so an indented block silently
# survived into the body and no JSON-LD was emitted.
INDENTED_SAMPLE = """\
# 高端醫保指南
%%meta desc=高端醫保解說%%

主要分別有以下幾點：

* **「全數賠償」概念**：
  普通醫保通常設有細項上限。

  %%defterm name=全數賠償%%
  保險公司不設各個細項的賠償上限，全額實報實銷醫療開支。
  %%end%%

* **自付額**：
  選擇自付額越高，保費折扣越大。

\t%%defterm name=自付額%%
\t俗稱「墊底費」，投保人必須自行承擔的合資格醫療費用金額。
\t%%end%%

## 常見問題
   %%acf_faq type=q%%
   什麼是「全數賠償」？
   %%acf_faq type=a%%
   不設各個分項的賠償上限。
   %%end%%
"""


def test_indented_defterm_inside_list_is_stripped_and_schema_emitted():
    r = render_html(INDENTED_SAMPLE)
    assert "%%defterm" not in r.html_body
    assert "%%end%%" not in r.html_body
    assert '<script type="application/ld+json">' not in r.html_body
    dts = _defterm_piece(r)
    assert dts is not None
    names = [t["name"] for t in dts["hasDefinedTerm"]]
    assert names == ["全數賠償", "自付額"]


def test_indented_faq_is_stripped_and_schema_emitted():
    r = render_html(INDENTED_SAMPLE)
    assert "%%acf_faq" not in r.html_body
    assert r.faq_schema_jsonld is not None
    assert r.faq_schema_jsonld["@type"] == "FAQPage"
    assert len(r.faq_schema_jsonld["mainEntity"]) == 1
    assert r.faq_schema_jsonld["mainEntity"][0]["name"] == "什麼是「全數賠償」？"


# Regression for run b56515ba: the writer inlined defterm blocks inside CJK
# quotes (e.g. 「%%defterm name=回南天%%描述%%end%%」). The old regex required
# newlines between markers, so the whole block survived into the published HTML
# as literal marker text. We now (a) tolerate inline form, (b) replace the
# inline block with just the term name so quotes don't collapse to empty 「」,
# (c) still emit the DefinedTermSet JSON-LD, and (d) hard-fail on any residual
# marker fragment so future writer quirks can't silently leak again.
INLINE_DEFTERM_SAMPLE = """\
# 立春指南
%%meta desc=立春時節養生重點%%

香港立春時節伴隨「%%defterm name=回南天%%指華南春季潮濕多霧天氣，水汽凝結令牆壁滲水。%%end%%」嘅潮濕天氣，亦易誘發「%%defterm name=春困%%春季濕氣困脾胃，令人精神不振、昏昏欲睡嘅生理現象。%%end%%」。

%%adv_panel id=1%%

## 養生重點

配置一份「%%defterm name=自願醫保%%（VHIS）係政府推行嘅個人住院醫保計劃。%%end%%」可加強防護。

%%page_widget id=2%%
"""


def test_inline_defterm_replaced_with_term_name():
    r = render_html(INLINE_DEFTERM_SAMPLE)
    # No raw marker text leaks into the body.
    assert "%%defterm" not in r.html_body
    assert "%%end%%" not in r.html_body
    # Inline blocks were wrapped in 「…」 — the visible term must survive so
    # the sentence doesn't collapse to empty quotes.
    assert "「回南天」" in r.html_body
    assert "「春困」" in r.html_body
    assert "「自願醫保」" in r.html_body


def test_inline_defterm_still_emits_definedtermset_jsonld():
    r = render_html(INLINE_DEFTERM_SAMPLE)
    assert '<script type="application/ld+json">' not in r.html_body
    dts = _defterm_piece(r)
    assert dts is not None
    names = [t["name"] for t in dts["hasDefinedTerm"]]
    assert names == ["回南天", "春困", "自願醫保"]


# Regression for runs e509ceb3 / 0bc89ae6 (Malaysia zh-MY / en-MY voices): the
# writer emitted block-form defterms with multi-word names ("Surat Rujukan",
# "Klinik Kesihatan"). The old `name=(\S+?)` stopped at the first space, so the
# block never matched, survived stripping, and tripped the residue guard —
# erroring the whole run with "unhandled defterm marker survived stripping".
MULTIWORD_DEFTERM_SAMPLE = """\
# Panduan Rujukan Pesakit
%%meta desc=Cara mendapatkan rujukan pakar di Malaysia%%

Pesakit perlu mengimbas mesin atau beratur untuk mengambil nombor giliran.

%%defterm name=Surat Rujukan%%
Surat daripada doktor yang merujuk pesakit kepada pakar.
%%end%%

Bawa surat ini supaya pakar dapat memahami sejarah perubatan anda.

%%defterm name=Klinik Kesihatan%%
Klinik kerajaan yang menyediakan rawatan kesihatan asas.
%%end%%

%%page_widget id=2%%
"""


def test_multiword_defterm_name_is_stripped_and_schema_emitted():
    r = render_html(MULTIWORD_DEFTERM_SAMPLE)
    assert "%%defterm" not in r.html_body
    assert "%%end%%" not in r.html_body
    dts = _defterm_piece(r)
    assert dts is not None
    names = [t["name"] for t in dts["hasDefinedTerm"]]
    assert names == ["Surat Rujukan", "Klinik Kesihatan"]


def test_orphan_defterm_open_marker_refuses_render():
    """Half-broken shortcode (open without close) must hard-fail rather than
    silently leak the marker into the published HTML."""
    bad = """\
# 標題
%%meta desc=說明%%

正文段落含一個未閉合嘅 %%defterm name=X%% 描述但無 end marker。
"""
    with pytest.raises(ValueError, match="defterm"):
        render_html(bad)


def test_orphan_defterm_end_marker_refuses_render():
    """Stray `%%end%%` outside a FAQ or defterm block must also hard-fail."""
    bad = """\
# 標題
%%meta desc=說明%%

正文段落含一個孤兒 %%end%% marker。
"""
    with pytest.raises(ValueError, match="defterm"):
        render_html(bad)
