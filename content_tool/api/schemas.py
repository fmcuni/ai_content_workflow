from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class CreateRunRequest(BaseModel):
    article_url: str
    topic: str
    keywords: list[str]
    mode: Literal["auto", "small_refresh", "full_rewrite"] = "auto"
    edit_note: str | None = None
    acf_adv_id: int
    acf_widget_id: int
    persona: str = "bowtie-editor"
    topic_category: str | None = None
    editor_email: str = Field(description="Identifies who triggered the run")
    triggered_by_evaluation_id: UUID | None = None


class CreateRunResponse(BaseModel):
    run_id: UUID
    status: str
    created_at: datetime
    article_id: UUID | None = None


class ResumeRequest(BaseModel):
    decision: Literal["approve", "edit_outline", "override_route", "cancel"]
    edited_outline: dict | None = None
    new_route: Literal["small_refresh", "full_rewrite"] | None = None
    notes: str | None = None


class Hitl2Request(BaseModel):
    decision: Literal["approve", "request_changes", "reject"]
    notes: str | None = None
    edited_html_body: str | None = None      # if editor tweaked HTML
    edited_seo_title: str | None = None
    edited_meta_description: str | None = None
    wp_publish_status: Literal["draft", "future", "publish"] = "draft"
    wp_author_id: int | None = None
    wp_category_ids: list[int] | None = None
    wp_tag_ids: list[int] | None = None
    wp_featured_media_id: int | None = None
    wp_slug: str | None = None
    wp_excerpt: str | None = None
    wp_publish_at: datetime | None = None


class DryPublishResponse(BaseModel):
    target_base_url: str
    target_label: str                    # staging | production
    request_method: Literal["PUT", "POST"]
    request_url: str
    request_headers: dict[str, str]
    request_body: dict


class RefreshEvaluationOut(BaseModel):
    evaluation_id: UUID
    evaluated_at: datetime
    age_days: int
    staleness_score: Decimal
    recommended_action: Literal["refresh", "monitor", "ok"]
    deterministic_findings: dict
    llm_findings: dict | None = None
    llm_skipped_reason: str | None = None
    outcome: Literal["open", "triggered", "dismissed", "superseded"]
    resulting_run_id: UUID | None = None


class ArticleOut(BaseModel):
    article_id: UUID
    article_url: str
    wp_post_id: int | None = None
    topic: str | None = None
    persona: str | None = None
    topic_category: str | None = None
    first_seen_at: datetime
    last_persisted_at: datetime | None = None
    next_scan_due_at: datetime
    dismissed_until: datetime | None = None
    latest_evaluation: RefreshEvaluationOut | None = None
    open_runs_count: int = 0


class ArticleListResponse(BaseModel):
    items: list[ArticleOut]
    total: int


class ArticleDetailOut(ArticleOut):
    recent_evaluations: list[RefreshEvaluationOut] = Field(default_factory=list)
    recent_run_ids: list[UUID] = Field(default_factory=list)


class DismissRequest(BaseModel):
    until: datetime
    reason: str | None = None
    dismissed_by: str


class ScanRequest(BaseModel):
    article_ids: list[UUID] | None = None
    force: bool = False


class ScanResponse(BaseModel):
    tick_id: UUID
    scanned: int
    evaluations_created: int
    llm_calls: int
    est_cost_usd_cents: int
    started_at: datetime
    finished_at: datetime
    skipped: list[dict]  # [{ "article_id": UUID, "reason": str }]
