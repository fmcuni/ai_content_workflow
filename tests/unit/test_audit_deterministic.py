from content_tool.agents.audit_checks import run_deterministic_checks

GOOD_HTML = """\
<script type="application/ld+json">{"@type":"FAQPage"}</script>
<p>first paragraph.</p>
[adv_panel id="1"]
<h2>section</h2>
<p>body</p>
[page_widget id="2"]
<h2>常見問題</h2>
<div class="editor__item editor__faq">faq...</div>
<h2>資訊來源</h2>
<ol><li><a href="https://a.gov/x">a.gov</a></li></ol>
"""


def test_passes_clean_html():
    findings = run_deterministic_checks(GOOD_HTML, citations_denied_displayed=False)
    assert all(f["severity"] != "high" for f in findings)


def test_flags_missing_adv_panel():
    html = GOOD_HTML.replace('[adv_panel id="1"]', "")
    findings = run_deterministic_checks(html, citations_denied_displayed=False)
    cats = {f["category"] for f in findings}
    assert "format" in cats


def test_flags_missing_page_widget():
    html = GOOD_HTML.replace('[page_widget id="2"]', "")
    findings = run_deterministic_checks(html, citations_denied_displayed=False)
    assert any(f["category"] == "format" and "page_widget" in f["issue"] for f in findings)


def test_flags_denied_citation_displayed():
    findings = run_deterministic_checks(GOOD_HTML, citations_denied_displayed=True)
    assert any(f["category"] == "citation" and f["must_fix"] for f in findings)


def test_flags_missing_sources_section():
    html = GOOD_HTML.replace("<h2>資訊來源</h2>", "")
    findings = run_deterministic_checks(html, citations_denied_displayed=False)
    assert any(f["category"] == "format" and "資訊來源" in f["issue"] for f in findings)
