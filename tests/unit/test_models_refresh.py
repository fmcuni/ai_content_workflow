from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from content_tool.db.models import Article, RefreshEvaluation, Run


def test_article_instantiation():
    a = Article(
        article_url="https://bowtie.com.hk/vhis/premium-guide",
        next_scan_due_at=datetime.now(timezone.utc),
    )
    assert a.article_url == "https://bowtie.com.hk/vhis/premium-guide"
    assert a.wp_post_id is None


def test_refresh_evaluation_required_fields():
    eid = uuid4()
    aid = uuid4()
    ev = RefreshEvaluation(
        evaluation_id=eid,
        article_id=aid,
        scanner_version="scanner@0.1.0",
        trigger_source="cron",
        age_days=120,
        deterministic_findings={"findings": [], "severity_high": 0, "severity_medium": 0, "severity_low": 0, "passed": True},
        staleness_score=Decimal("4.20"),
        recommended_action="monitor",
        outcome="open",
    )
    assert ev.recommended_action == "monitor"


def test_run_has_new_columns():
    r = Run(
        created_by="editor@bowtie.local",
        status="pending",
        article_url="x", topic="x", keywords=[], mode="small_refresh",
        acf_adv_id=0, acf_widget_id=0, persona="default",
        today_date=datetime.now(timezone.utc).date(),
        article_id=uuid4(),
        triggered_by_evaluation_id=uuid4(),
    )
    assert r.article_id is not None
    assert r.triggered_by_evaluation_id is not None
