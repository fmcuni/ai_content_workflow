from datetime import datetime
from pathlib import Path
import httpx
import pytest
import respx

from content_tool.refresh.deterministic_checks import (
    check_dated_phrasing, check_missing_faq_jsonld, check_html_drift,
    check_broken_links, deterministic_audit_published_html,
)

FIX = Path("tests/fixtures/html")


def load(name: str) -> str:
    return (FIX / name).read_text()


def test_check_dated_phrasing_finds_old_years():
    html = load("article_dated_phrasing.html")
    findings = check_dated_phrasing(html, now=datetime(2026, 5, 22))
    assert any("as of 2022" in f.message.lower() for f in findings)
    assert all(f.severity == "low" for f in findings)


def test_check_dated_phrasing_ok_when_current():
    html = load("article_ok.html")
    findings = check_dated_phrasing(html, now=datetime(2026, 5, 22))
    # The 2025 reference is within lookback=1 (threshold_year=2025), so 2025 is OK
    old = [f for f in findings if f.context and f.context.get("year", 9999) < 2025]
    assert old == []


def test_check_missing_faq_jsonld_flags_when_missing():
    findings = check_missing_faq_jsonld(load("article_missing_faq_jsonld.html"))
    assert len(findings) == 1
    assert findings[0].severity == "high"


def test_check_missing_faq_jsonld_ok_when_present():
    assert check_missing_faq_jsonld(load("article_ok.html")) == []


def test_check_html_drift_catches_h2_to_h4_skip():
    findings = check_html_drift(load("article_drift.html"))
    assert len(findings) == 1
    assert findings[0].severity == "medium"


@respx.mock
@pytest.mark.asyncio
async def test_check_broken_links_flags_4xx():
    respx.head("https://broken.example.invalid/page").mock(return_value=httpx.Response(404))
    respx.head("https://another-broken.invalid").mock(return_value=httpx.Response(404))
    respx.head("https://yet-another.invalid").mock(return_value=httpx.Response(404))
    respx.get("https://broken.example.invalid/page").mock(return_value=httpx.Response(404))
    respx.get("https://another-broken.invalid").mock(return_value=httpx.Response(404))
    respx.get("https://yet-another.invalid").mock(return_value=httpx.Response(404))
    findings = await check_broken_links(load("article_broken_links.html"))
    assert len(findings) == 3
    assert all(f.severity == "medium" for f in findings)


@respx.mock
@pytest.mark.asyncio
async def test_full_audit_ok_html_passes(monkeypatch):
    # Mock outbound link checks to return 200
    respx.head("https://bowtie.com.hk/about/").mock(return_value=httpx.Response(200))
    respx.head("https://www.ia.org.hk/").mock(return_value=httpx.Response(200))
    result = await deterministic_audit_published_html(load("article_ok.html"))
    assert result.passed
    assert result.severity_high == 0
