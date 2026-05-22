"""Deterministic checks against currently-published HTML."""
from __future__ import annotations

import asyncio
import itertools
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

import httpx
from bs4 import BeautifulSoup

from content_tool.config import get_refresh_config

Severity = Literal["high", "medium", "low"]

@dataclass
class Finding:
    id: str
    severity: Severity
    message: str
    context: dict | None = None

@dataclass
class DeterministicResult:
    findings: list[Finding] = field(default_factory=list)
    severity_high: int = 0
    severity_medium: int = 0
    severity_low: int = 0

    def add(self, f: Finding) -> None:
        self.findings.append(f)
        if f.severity == "high":
            self.severity_high += 1
        elif f.severity == "medium":
            self.severity_medium += 1
        else:
            self.severity_low += 1

    @property
    def passed(self) -> bool:
        cfg = get_refresh_config()["deterministic"]
        return (
            self.severity_high == 0
            and self.severity_medium <= cfg["audit_det_medium_threshold"]
        )

    def to_jsonb(self) -> dict:
        return {
            "findings": [
                {"id": f.id, "severity": f.severity, "message": f.message, "context": f.context}
                for f in self.findings
            ],
            "severity_high": self.severity_high,
            "severity_medium": self.severity_medium,
            "severity_low": self.severity_low,
            "passed": self.passed,
        }


async def check_broken_links(html: str, client: httpx.AsyncClient | None = None) -> list[Finding]:
    cfg = get_refresh_config()["deterministic"]
    soup = BeautifulSoup(html, "html.parser")
    urls: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not href.startswith("http"):
            continue
        if any(dom in href for dom in cfg["link_check_ignore_domains"]):
            continue
        urls.append(href)

    if not urls:
        return []

    sem = asyncio.Semaphore(cfg["link_check_concurrency"])
    findings: list[Finding] = []
    timeout = cfg["link_check_timeout_ms"] / 1000.0
    close_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)

    async def check_one(u: str) -> None:
        async with sem:
            try:
                r = await client.head(u, timeout=timeout)
                if r.status_code >= 400:
                    r = await client.get(u, timeout=timeout)
                if r.status_code >= 400:
                    findings.append(Finding(
                        id="det-link-broken", severity="medium",
                        message=f"Broken link: {u} ({r.status_code})",
                        context={"url": u, "status": r.status_code},
                    ))
            except Exception as e:
                findings.append(Finding(
                    id="det-link-broken", severity="medium",
                    message=f"Broken link: {u} ({type(e).__name__})",
                    context={"url": u, "error": str(e)[:200]},
                ))

    try:
        await asyncio.gather(*(check_one(u) for u in urls))
    finally:
        if close_client:
            await client.aclose()
    return findings


def check_dated_phrasing(html: str, now: datetime | None = None) -> list[Finding]:
    cfg = get_refresh_config()["deterministic"]
    now = now or datetime.now()
    lookback = cfg["dated_phrasing_year_lookback"]
    threshold_year = now.year - lookback
    findings: list[Finding] = []
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ")

    for m in re.finditer(r"\bas of (\w+ )?(\d{4})\b", text, re.IGNORECASE):
        year = int(m.group(2))
        if year < threshold_year:
            findings.append(Finding(
                id="det-dated-phrasing", severity="low",
                message=f"Dated phrasing: '{m.group(0)}'", context={"year": year},
            ))
    for m in re.finditer(r"\b(20\d{2})\b", text):
        year = int(m.group(1))
        prefix = text[max(0, m.start() - 8):m.start()]
        if year < threshold_year and not re.search(r"as of", prefix, re.IGNORECASE):
            findings.append(Finding(
                id="det-old-year", severity="low",
                message=f"Old year reference: {year}", context={"year": year},
            ))
    return findings


def check_missing_faq_jsonld(html: str) -> list[Finding]:
    has_faq_shortcode = bool(re.search(r"\[acf_widget [^\]]*\]", html)) or "bowtie-faq" in html
    has_faq_jsonld = bool(re.search(r"FAQPage", html))
    if has_faq_shortcode and not has_faq_jsonld:
        return [Finding(
            id="det-missing-faq-jsonld", severity="high",
            message="FAQ widget present but FAQPage JSON-LD missing", context=None,
        )]
    return []


def check_html_drift(html: str) -> list[Finding]:
    """Coarse structural drift detector. Catches obvious skips in heading hierarchy."""
    findings: list[Finding] = []
    soup = BeautifulSoup(html, "html.parser")
    headings = [int(h.name[1]) for h in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"])]
    for prev, cur in itertools.pairwise(headings):
        if cur > prev + 1:
            findings.append(Finding(
                id="det-heading-skip", severity="medium",
                message=f"Heading skip: h{prev} → h{cur}", context={"prev": prev, "cur": cur},
            ))
            break
    return findings


async def deterministic_audit_published_html(
    html: str,
    *,
    modified_gmt: str | None = None,
    last_persisted_at: datetime | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> DeterministicResult:
    result = DeterministicResult()
    for f in await check_broken_links(html, client=http_client):
        result.add(f)
    for f in check_dated_phrasing(html):
        result.add(f)
    for f in check_missing_faq_jsonld(html):
        result.add(f)
    for f in check_html_drift(html):
        result.add(f)
    return result
