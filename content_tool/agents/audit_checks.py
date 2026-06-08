import re
from typing import Any


def run_deterministic_checks(
    html_body: str,
    *,
    citations_denied_displayed: bool,
    schema_jsonld: list[dict[str, Any]] | None = None,
    adv_enabled: bool = True,
    widget_enabled: bool = True,
) -> list[dict[str, Any]]:
    # ``adv_enabled`` / ``widget_enabled`` are False when the run's acf id is 0
    # (the "no element" sentinel): the shortcode is intentionally absent, so its
    # presence check is skipped rather than flagged as a must-fix finding.
    findings: list[dict[str, Any]] = []

    if adv_enabled and not re.search(r'\[adv_panel id="\d+"\]', html_body):
        findings.append({
            "id": "det-fmt-adv", "category": "format", "severity": "high",
            "location": "body", "issue": "缺少 [adv_panel id=...] shortcode",
            "suggested_fix": "在首段後加入 adv_panel shortcode",
            "must_fix": True,
        })

    if widget_enabled and not re.search(r'\[page_widget id="\d+"\]', html_body):
        findings.append({
            "id": "det-fmt-widget", "category": "format", "severity": "high",
            "location": "body", "issue": "缺少 [page_widget id=...] shortcode",
            "suggested_fix": "在常見問題前加入 page_widget shortcode",
            "must_fix": True,
        })

    # Accept either Chinese script — the sources heading follows the voice's
    # script (see resolve_citations), so a zh-MY voice emits Simplified.
    if "<h2>資訊來源</h2>" not in html_body and "<h2>资讯来源</h2>" not in html_body:
        findings.append({
            "id": "det-fmt-sources", "category": "format", "severity": "high",
            "location": "tail", "issue": "缺少 <h2>資訊來源</h2> section",
            "suggested_fix": "確保 resolve_citations 已產生資訊來源 section",
            "must_fix": True,
        })

    if 'class="editor__item editor__faq"' not in html_body:
        findings.append({
            "id": "det-fmt-faq", "category": "format", "severity": "high",
            "location": "tail", "issue": "缺少 Bowtie FAQ widget div",
            "suggested_fix": "render_html 必須輸出 editor__faq 結構",
            "must_fix": True,
        })

    # FAQ JSON-LD is now delivered OUT-OF-BAND (schema_jsonld → _bowtie_schema_jsonld
    # post meta → Yoast/RankMath schema filter → page <head>), so we no longer
    # look for a <script> in the body. Instead: whenever the visible FAQ widget
    # is present, the schema graph must carry a matching FAQPage piece.
    has_faq_widget = 'class="editor__item editor__faq"' in html_body
    has_faqpage = any(
        isinstance(p, dict) and p.get("@type") == "FAQPage"
        for p in (schema_jsonld or [])
    )
    if has_faq_widget and not has_faqpage:
        findings.append({
            "id": "det-fmt-jsonld", "category": "format", "severity": "high",
            "location": "head", "issue": "FAQ widget 存在但 schema_jsonld 缺少 FAQPage",
            "suggested_fix": "render_html 必須輸出 FAQPage 至 schema_jsonld (經 post meta 交付, 不再注入 body)",  # noqa: E501
            "must_fix": True,
        })

    if citations_denied_displayed:
        findings.append({
            "id": "det-cite-denied", "category": "citation", "severity": "high",
            "location": "資訊來源", "issue": "顯示了被 policy 拒絕的來源",
            "suggested_fix": "改用 GOV / EDU 等高可信來源",
            "must_fix": True,
        })

    return findings
