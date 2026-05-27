from datetime import datetime
from decimal import Decimal
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class CreateRunRequest(BaseModel):
    article_url: str | None = None
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
    start_mode: Literal["refresh", "create"] = "refresh"
    topic_candidate_id: UUID | None = None
    target_audience: str | None = None

    @model_validator(mode="after")
    def _check_article_url_for_start_mode(self) -> Self:
        """refresh mode requires article_url; create mode forbids it (server-generated)."""
        if self.start_mode == "refresh" and not self.article_url:
            raise ValueError("article_url is required when start_mode='refresh'")
        if self.start_mode == "create" and self.article_url:
            raise ValueError(
                "article_url must be absent when start_mode='create' "
                "(server-generated after draft publish)"
            )
        return self


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


class Hitl2Comment(BaseModel):
    id: str
    anchor_text: str = Field(max_length=120)
    body: str


class Hitl2Request(BaseModel):
    decision: Literal["approve", "request_changes", "reject"]
    notes: str | None = None
    comments: list[Hitl2Comment] | None = None
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


class OutlineEditRequest(BaseModel):
    """Post-hoc outline edit for a finished run (no graph resume).

    Persists to ``outlines.human_edits`` so the durable record reflects the
    edit. Used by the standalone edit page, not the HITL_1 gate.
    """

    outline: dict


class ArticleEditRequest(BaseModel):
    """Post-hoc article edit for a finished run (no graph resume).

    Writes the body/SEO fields onto the latest Render row and the WP metadata
    onto the Run row, so a subsequent re-push reads the edited content.
    """

    html_body: str
    seo_title: str
    meta_description: str
    wp_publish_status: Literal["draft", "future", "publish"] | None = None
    wp_author_id: int | None = None
    wp_category_ids: list[int] | None = None
    wp_tag_ids: list[int] | None = None
    wp_featured_media_id: int | None = None
    wp_slug: str | None = None
    wp_excerpt: str | None = None
    wp_publish_at: datetime | None = None


class RepublishResponse(BaseModel):
    wp_post_id: int
    link: str | None = None
    status: str


class DryPublishRequest(BaseModel):
    """Optional in-progress edits from the HITL2 reviewer.

    When fields are set, they override the persisted Render / Run values
    so the preview reflects unsaved edits.
    """

    edited_html_body: str | None = None
    edited_seo_title: str | None = None
    edited_meta_description: str | None = None
    wp_publish_status: Literal["draft", "future", "publish"] | None = None
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


class ExistingPostOut(BaseModel):
    wp_post_id: int
    link: str | None = None
    wp_author_id: int | None = None
    wp_author_name: str | None = None
    wp_category_id: int | None = None
    wp_category_name: str | None = None
    wp_slug: str | None = None


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


# --- Personas ---------------------------------------------------------------

GlossaryStatus = Literal["preferred", "avoid", "forbidden", "do_not_translate"]


class GlossaryEntry(BaseModel):
    term: str = Field(min_length=1, max_length=200)
    preferred: str = Field(default="", max_length=200)
    variants: list[str] = Field(default_factory=list)
    status: GlossaryStatus = "preferred"
    notes: str | None = Field(default=None, max_length=500)


class DisclaimerTemplate(BaseModel):
    condition: str = Field(default="", max_length=500)
    disclaimer: str = Field(default="", max_length=2000)


class PersonaIn(BaseModel):
    slug: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
    name: str = Field(min_length=1, max_length=128)
    voice_rules: list[str]
    banned_terms: list[str]
    required_phrasings: list[str]
    disclaimer_templates: dict[str, DisclaimerTemplate]
    tone_examples: dict[str, list[str]]
    glossary: list[GlossaryEntry] = Field(default_factory=list)


class PersonaPatch(BaseModel):
    name: str | None = None
    voice_rules: list[str] | None = None
    banned_terms: list[str] | None = None
    required_phrasings: list[str] | None = None
    disclaimer_templates: dict[str, DisclaimerTemplate] | None = None
    tone_examples: dict[str, list[str]] | None = None
    glossary: list[GlossaryEntry] | None = None


class PersonaOut(BaseModel):
    persona_id: UUID
    slug: str
    name: str
    voice_rules: list[str]
    banned_terms: list[str]
    required_phrasings: list[str]
    disclaimer_templates: dict[str, DisclaimerTemplate]
    tone_examples: dict[str, list[str]]
    glossary: list[GlossaryEntry] = Field(default_factory=list)
    is_archived: bool
    created_at: datetime
    updated_at: datetime
    created_by: str | None
    updated_by: str | None


class PersonaUsage(BaseModel):
    slug: str
    by_status: dict[str, int]
    total: int


# --- Topic batches ----------------------------------------------------------

BatchStatus = Literal[
    "pending",
    "generating",
    "analysing",
    "ready_for_review",
    "partially_promoted",
    "done",
    "failed",
]

CandidateStatus = Literal["candidate", "promoted", "skipped", "errored"]

ExistingVerdict = Literal["yes", "no", "not_sure"]
HotTopicVerdict = Literal["yes", "no"]


class TopicBatchIn(BaseModel):
    """Brief-form payload that kicks off a topic-expansion batch."""

    research_theme: str = Field(min_length=1)
    target_audience: str = Field(min_length=1)
    topic_count: int = Field(ge=1, le=30, default=10)
    keywords_per_topic: int = Field(ge=1, le=10, default=5)
    must_cover: list[str] = Field(default_factory=list)
    must_avoid: list[str] = Field(default_factory=list)
    priority_focus: str | None = None
    notes: str | None = None
    persona_default: str | None = None
    acf_adv_id_default: int | None = None
    acf_widget_id_default: int | None = None
    editor_email: str = Field(description="Identifies who triggered the batch")


class TopicCandidateOut(BaseModel):
    candidate_id: UUID
    batch_id: UUID
    position: int
    status: CandidateStatus
    topic: str
    keywords: list[str]
    original_topic: str
    original_keywords: list[str]
    existing: ExistingVerdict | None = None
    existing_note: str | None = None
    existing_url: str | None = None
    hot_topic: HotTopicVerdict | None = None
    hot_topic_note: str | None = None
    persona_slug: str | None = None
    acf_adv_id: int | None = None
    acf_widget_id: int | None = None
    operator_note: str | None = None
    promote_mode: Literal["create", "refresh"] | None = None
    promoted_run_id: UUID | None = None
    last_error: str | None = None
    last_edited_by: str | None = None
    last_edited_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class TopicBatchOut(BaseModel):
    batch_id: UUID
    status: BatchStatus
    created_by: str
    created_at: datetime
    updated_at: datetime
    research_theme: str
    target_audience: str
    topic_count: int
    keywords_per_topic: int
    must_cover: list[str]
    must_avoid: list[str]
    priority_focus: str | None = None
    notes: str | None = None
    persona_default: str | None = None
    acf_adv_id_default: int | None = None
    acf_widget_id_default: int | None = None
    cost_cents: int = 0
    last_error: str | None = None
    candidates: list[TopicCandidateOut] | None = None


class TopicBatchCreateResponse(BaseModel):
    batch_id: UUID
    status: BatchStatus


class PatchCandidateIn(BaseModel):
    """Partial-update payload for a single candidate row.

    All fields are optional; only those explicitly set propagate to the row.
    ``editor_email`` identifies the operator so the server can stamp
    ``last_edited_by`` / ``last_edited_at``.
    """

    topic: str | None = Field(default=None, min_length=1)
    keywords: list[str] | None = None
    persona_slug: str | None = None
    acf_adv_id: int | None = None
    acf_widget_id: int | None = None
    operator_note: str | None = None
    editor_email: str = Field(description="Operator identifier for edit stamp")


class PromotionItem(BaseModel):
    candidate_id: UUID
    mode: Literal["create", "refresh"]


class PromoteRequest(BaseModel):
    promotions: list[PromotionItem] = Field(min_length=1)
    editor_email: str = Field(description="Identifies who is promoting")


class PromoteResponseItem(BaseModel):
    candidate_id: UUID
    run_id: UUID
    mode: Literal["create", "refresh"]


class PromoteResponse(BaseModel):
    items: list[PromoteResponseItem]
    batch_status: BatchStatus


class SkipCandidateRequest(BaseModel):
    editor_email: str = Field(description="Identifies who skipped the candidate")
