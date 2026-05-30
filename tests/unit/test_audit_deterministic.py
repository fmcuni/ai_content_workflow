from content_tool.agents.audit_checks import run_deterministic_checks

# JSON-LD is no longer inlined into the body — it ships out-of-band via post
# meta. The body still carries the visible FAQ widget div; the schema graph is
# passed alongside so the FAQPage check can verify it.
GOOD_HTML = """\
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

FAQ_SCHEMA = [{"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": []}]


def test_passes_clean_html():
    findings = run_deterministic_checks(
        GOOD_HTML, citations_denied_displayed=False, schema_jsonld=FAQ_SCHEMA
    )
    assert all(f["severity"] != "high" for f in findings)


def test_flags_missing_adv_panel():
    html = GOOD_HTML.replace('[adv_panel id="1"]', "")
    findings = run_deterministic_checks(
        html, citations_denied_displayed=False, schema_jsonld=FAQ_SCHEMA
    )
    cats = {f["category"] for f in findings}
    assert "format" in cats


def test_flags_missing_page_widget():
    html = GOOD_HTML.replace('[page_widget id="2"]', "")
    findings = run_deterministic_checks(
        html, citations_denied_displayed=False, schema_jsonld=FAQ_SCHEMA
    )
    assert any(f["category"] == "format" and "page_widget" in f["issue"] for f in findings)


def test_flags_denied_citation_displayed():
    findings = run_deterministic_checks(
        GOOD_HTML, citations_denied_displayed=True, schema_jsonld=FAQ_SCHEMA
    )
    assert any(f["category"] == "citation" and f["must_fix"] for f in findings)


def test_flags_missing_sources_section():
    html = GOOD_HTML.replace("<h2>資訊來源</h2>", "")
    findings = run_deterministic_checks(
        html, citations_denied_displayed=False, schema_jsonld=FAQ_SCHEMA
    )
    assert any(f["category"] == "format" and "資訊來源" in f["issue"] for f in findings)


def test_flags_faq_widget_without_schema():
    """FAQ widget visible in body but no FAQPage in the out-of-band schema graph
    → must_fix det-fmt-jsonld finding (the page would render the widget with no
    structured data)."""
    findings = run_deterministic_checks(
        GOOD_HTML, citations_denied_displayed=False, schema_jsonld=None
    )
    assert any(
        f["id"] == "det-fmt-jsonld" and f["must_fix"] and f["severity"] == "high"
        for f in findings
    )


def test_no_faq_widget_means_no_jsonld_finding():
    """No FAQ widget → no FAQPage requirement, even with an empty schema graph."""
    html = GOOD_HTML.replace(
        '<div class="editor__item editor__faq">faq...</div>', ""
    )
    findings = run_deterministic_checks(
        html, citations_denied_displayed=False, schema_jsonld=None
    )
    assert not any(f["id"] == "det-fmt-jsonld" for f in findings)
