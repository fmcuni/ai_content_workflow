from datetime import date, datetime
from uuid import UUID, uuid4

from sqlalchemy import (  # noqa: F401
    JSON,
    TIMESTAMP,
    Boolean,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship  # noqa: F401


class Base(DeclarativeBase):
    __table_args__ = {"schema": "content_tool"}  # noqa: RUF012


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (
        Index("runs_status_idx", "status"),
        Index("runs_created_at_idx", "created_at"),
        {"schema": "content_tool"},
    )

    run_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)
    article_url: Mapped[str] = mapped_column(String, nullable=False)
    topic: Mapped[str] = mapped_column(String, nullable=False)
    keywords: Mapped[list] = mapped_column(JSONB, nullable=False)
    mode: Mapped[str] = mapped_column(String, nullable=False)
    edit_note: Mapped[str | None] = mapped_column(String)
    acf_adv_id: Mapped[int]
    acf_widget_id: Mapped[int]
    persona: Mapped[str] = mapped_column(String, nullable=False)
    topic_category: Mapped[str | None] = mapped_column(String)
    today_date: Mapped[date]
    chosen_route: Mapped[str | None] = mapped_column(String)
    iteration_count: Mapped[int] = mapped_column(default=0)
    error: Mapped[dict | None] = mapped_column(JSONB)

    # WP fields (filled at HITL_2 — see Plan 5; declared here for schema completeness)
    wp_author_id: Mapped[int | None]
    wp_category_ids: Mapped[list | None] = mapped_column(JSONB)
    wp_tag_ids: Mapped[list | None] = mapped_column(JSONB)
    wp_featured_media_id: Mapped[int | None]
    wp_slug: Mapped[str | None] = mapped_column(String)
    wp_excerpt: Mapped[str | None] = mapped_column(String)
    wp_publish_status: Mapped[str | None] = mapped_column(String)
    wp_publish_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    wp_pushed_post_id: Mapped[int | None]
    wp_pushed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    wp_push_error: Mapped[dict | None] = mapped_column(JSONB)
    hitl_1_decision: Mapped[str | None] = mapped_column(String)
    hitl_1_notes: Mapped[str | None] = mapped_column(String)
    hitl_2_decision: Mapped[str | None] = mapped_column(String)
    hitl_2_notes: Mapped[str | None] = mapped_column(String)
    approved_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    approved_by: Mapped[str | None] = mapped_column(String)


class GapAnalysisRow(Base):
    __tablename__ = "gap_analyses"

    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), primary_key=True  # noqa: E501
    )
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    model: Mapped[str] = mapped_column(String, nullable=False)
    thinking_level: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    tokens_in: Mapped[int | None]
    tokens_out: Mapped[int | None]
    thinking_tokens: Mapped[int | None]
    latency_ms: Mapped[int | None]
    raw_response: Mapped[dict | None] = mapped_column(JSONB)


class FetchedArticle(Base):
    __tablename__ = "fetched_articles"

    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"),
        primary_key=True,
    )
    fetched_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    wp_post_id: Mapped[int | None]
    wp_categories: Mapped[list | None] = mapped_column(JSONB)
    raw_html: Mapped[str | None] = mapped_column(String)
    markdown: Mapped[str] = mapped_column(String, nullable=False)


class OutlineRow(Base):
    __tablename__ = "outlines"

    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    edited_by_human: Mapped[bool] = mapped_column(default=False)
    human_edits: Mapped[dict | None] = mapped_column(JSONB)


class Draft(Base):
    __tablename__ = "drafts"
    __table_args__ = (UniqueConstraint("run_id", "iteration"), {"schema": "content_tool"})

    draft_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"),
        nullable=False,
    )
    iteration: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    diagnose: Mapped[str] = mapped_column(String, nullable=False)
    markup_raw: Mapped[str] = mapped_column(String, nullable=False)
    final_markup: Mapped[str | None] = mapped_column(String)
    citation_intents: Mapped[list] = mapped_column(JSONB, nullable=False)
    grounding_chunks: Mapped[list | None] = mapped_column(JSONB)
    tokens_in: Mapped[int | None]
    tokens_out: Mapped[int | None]
    thinking_tokens: Mapped[int | None]
    latency_ms: Mapped[int | None]


class Citation(Base):
    __tablename__ = "citations"

    citation_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)  # noqa: E501
    draft_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"),
        nullable=False,
    )
    chunk_idx: Mapped[int | None]
    vertex_uri: Mapped[str] = mapped_column(String, nullable=False)
    final_url: Mapped[str | None] = mapped_column(String)
    domain: Mapped[str | None] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String)
    policy_decision: Mapped[str] = mapped_column(String, nullable=False)
    denied_reason: Mapped[str | None] = mapped_column(String)
    was_displayed: Mapped[bool] = mapped_column(Boolean, default=False)
    resolution_error: Mapped[str | None] = mapped_column(String)
    resolved_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501


class UrlResolutionCache(Base):
    __tablename__ = "url_resolution_cache"

    vertex_uri: Mapped[str] = mapped_column(String, primary_key=True)
    final_url: Mapped[str | None] = mapped_column(String)
    domain: Mapped[str | None] = mapped_column(String)
    resolved_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    error: Mapped[str | None] = mapped_column(String)


class Render(Base):
    __tablename__ = "renders"

    render_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    draft_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    seo_title: Mapped[str] = mapped_column(String, nullable=False)
    meta_description: Mapped[str] = mapped_column(String, nullable=False)
    html_body: Mapped[str] = mapped_column(String, nullable=False)
    faq_schema_jsonld: Mapped[dict | None] = mapped_column(JSONB)
    excerpt_suggestion: Mapped[str | None] = mapped_column(String)
    slug_suggestion: Mapped[str | None] = mapped_column(String)


class AuditRun(Base):
    __tablename__ = "audit_runs"

    audit_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    draft_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    overall_pass: Mapped[bool]
    severity_high: Mapped[int] = mapped_column(default=0)
    severity_medium: Mapped[int] = mapped_column(default=0)
    severity_low: Mapped[int] = mapped_column(default=0)
    llm_findings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    deterministic_findings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    tokens_in: Mapped[int | None]
    tokens_out: Mapped[int | None]
    latency_ms: Mapped[int | None]


class ComplianceLog(Base):
    __tablename__ = "compliance_log"

    log_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.runs.run_id"),
        unique=True,
        nullable=False,
    )
    persisted_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))  # noqa: E501
    persona: Mapped[str] = mapped_column(String, nullable=False)
    article_url: Mapped[str] = mapped_column(String, nullable=False)
    wp_pushed_post_id: Mapped[int | None]
    chosen_route: Mapped[str] = mapped_column(String, nullable=False)
    sources_cited: Mapped[str] = mapped_column(String, nullable=False)
    sources_denied: Mapped[str | None] = mapped_column(String)
    audit_overall_pass: Mapped[bool]
    audit_severity_summary: Mapped[dict] = mapped_column(JSONB, nullable=False)
    approver_email: Mapped[str] = mapped_column(String, nullable=False)
    iteration_count: Mapped[int]
    gemini_model: Mapped[str] = mapped_column(String, nullable=False)
    total_tokens: Mapped[int | None]
    est_cost_usd_cents: Mapped[int | None]


class Eval(Base):
    __tablename__ = "evals"

    eval_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    ran_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    metric: Mapped[str] = mapped_column(String, nullable=False)
    fixture_id: Mapped[str] = mapped_column(String, nullable=False)
    run_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True))
    score: Mapped[float | None]
    pass_: Mapped[bool] = mapped_column("pass", default=False)
    judge_notes: Mapped[dict | None] = mapped_column(JSONB)
    commit_sha: Mapped[str] = mapped_column(String, nullable=False)
