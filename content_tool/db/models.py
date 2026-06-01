from datetime import date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import (  # noqa: F401
    JSON,
    TIMESTAMP,
    Boolean,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship  # noqa: F401

from content_tool.db.base import Base


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
    article_url: Mapped[str | None] = mapped_column(String)
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
    hitl_2_comments: Mapped[list | None] = mapped_column(JSONB)
    hitl_2_iteration: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    approved_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    approved_by: Mapped[str | None] = mapped_column(String)
    article_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("content_tool.articles.article_id")
    )
    triggered_by_evaluation_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("content_tool.refresh_evaluations.evaluation_id")
    )
    start_mode: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'refresh'")
    )
    topic_candidate_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.topic_candidates.candidate_id"),
    )
    target_audience: Mapped[str | None] = mapped_column(String)


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
    wp_author_id: Mapped[int | None]
    wp_slug: Mapped[str | None] = mapped_column(String)
    wp_link: Mapped[str | None] = mapped_column(String)
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


class Hitl2Snapshot(Base):
    """Autosave / version-history snapshot of the HITL_2 reviewer's working state.

    Each row is one point-in-time capture of the editor body, SEO/WP metadata,
    overall notes, and anchored comments — written on a 5-minute interval, when
    the reviewer leaves the page, or on tab close. Browsable + restorable from
    the galley page. Bounded to the newest ~50 rows per run by the writer.
    """

    __tablename__ = "hitl2_snapshots"
    __table_args__ = (
        Index("hitl2_snapshots_run_created_idx", "run_id", "created_at"),
        {"schema": "content_tool"},
    )

    snapshot_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    created_by: Mapped[str | None] = mapped_column(String)
    trigger: Mapped[str] = mapped_column(String, nullable=False)
    html_body: Mapped[str] = mapped_column(String, nullable=False)
    seo_title: Mapped[str | None] = mapped_column(String)
    meta_description: Mapped[str | None] = mapped_column(String)
    notes: Mapped[str | None] = mapped_column(String)
    comments: Mapped[list | None] = mapped_column(JSONB)
    wp_publish_status: Mapped[str | None] = mapped_column(String)
    wp_author_id: Mapped[int | None]
    wp_category_ids: Mapped[list | None] = mapped_column(JSONB)
    wp_tag_ids: Mapped[list | None] = mapped_column(JSONB)
    wp_featured_media_id: Mapped[int | None]
    wp_slug: Mapped[str | None] = mapped_column(String)
    wp_excerpt: Mapped[str | None] = mapped_column(String)
    wp_publish_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))


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
    # Full structured-data graph (list of schema.org pieces: FAQPage,
    # DefinedTermSet, ...) shipped out-of-band to WordPress via the
    # _bowtie_schema_jsonld post meta key, NOT inlined into html_body.
    schema_jsonld: Mapped[list[dict[str, object]] | None] = mapped_column(JSONB)
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


class Article(Base):
    __tablename__ = "articles"
    __table_args__ = (
        Index("articles_next_scan_due_idx", "next_scan_due_at"),
        Index("articles_wp_post_id_idx", "wp_post_id"),
        UniqueConstraint("article_url", name="articles_article_url_uidx"),
        {"schema": "content_tool"},
    )

    article_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    article_url: Mapped[str] = mapped_column(String, nullable=False)
    wp_post_id: Mapped[int | None]
    topic: Mapped[str | None] = mapped_column(String)
    persona: Mapped[str | None] = mapped_column(String)
    topic_category: Mapped[str | None] = mapped_column(String)
    first_seen_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    last_persisted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    next_scan_due_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    dismissed_until: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    dismissed_by: Mapped[str | None] = mapped_column(String)
    dismissed_reason: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))


class RefreshEvaluation(Base):
    __tablename__ = "refresh_evaluations"
    __table_args__ = (
        Index("refresh_evals_article_evaluated_idx", "article_id", "evaluated_at"),
        {"schema": "content_tool"},
    )

    evaluation_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    article_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_tool.articles.article_id", ondelete="CASCADE"),
        nullable=False,
    )
    evaluated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    scanner_version: Mapped[str] = mapped_column(String, nullable=False)
    trigger_source: Mapped[str] = mapped_column(String, nullable=False)
    age_days: Mapped[int] = mapped_column(Integer, nullable=False)
    fetched_html_hash: Mapped[str | None] = mapped_column(String)
    deterministic_findings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    llm_findings: Mapped[dict | None] = mapped_column(JSONB)
    llm_skipped_reason: Mapped[str | None] = mapped_column(String)
    staleness_score: Mapped[Decimal] = mapped_column(Numeric(4, 2), nullable=False)
    recommended_action: Mapped[str] = mapped_column(String, nullable=False)
    outcome: Mapped[str] = mapped_column(String, nullable=False, server_default=text("'open'"))
    resulting_run_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("content_tool.runs.run_id")
    )
    outcome_set_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    outcome_set_by: Mapped[str | None] = mapped_column(String)
    tokens_in: Mapped[int | None]
    tokens_out: Mapped[int | None]
    est_cost_usd_cents: Mapped[int | None]
    latency_ms: Mapped[int | None]


class WpUserCache(Base):
    __tablename__ = "wp_users"
    __table_args__ = (
        Index("wp_users_name_idx", "name"),
        {"schema": "content_tool"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, nullable=False)
    synced_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )


class WpCategoryCache(Base):
    __tablename__ = "wp_categories"
    __table_args__ = (
        Index("wp_categories_name_idx", "name"),
        {"schema": "content_tool"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, nullable=False)
    synced_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )


class PromptVersion(Base):
    """Immutable history row for every prompt-template save or revert.

    The on-disk file under ``prompts/`` is the live copy; this table is the
    audit trail and the source for the editor's "History" panel + one-click
    revert. ``parent_sha256`` chains rows so the lineage is recoverable even
    if ``saved_at`` ties.
    """

    __tablename__ = "prompt_versions"
    __table_args__ = (
        Index("prompt_versions_template_idx", "template_id", "saved_at"),
        {"schema": "content_tool"},
    )

    version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    template_id: Mapped[str] = mapped_column(String, nullable=False)
    sha256: Mapped[str] = mapped_column(String, nullable=False)
    parent_sha256: Mapped[str | None] = mapped_column(String)
    body: Mapped[str] = mapped_column(String, nullable=False)
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    saved_by: Mapped[str] = mapped_column(String, nullable=False)
    saved_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    kind: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'save'")
    )


class PromptTemplate(Base):
    """Live prompt-template body — the source of truth the runtime reads from.

    One row per ``template_id`` (agent prompts, shared partials, eval judges).
    The editor at ``/prompts`` updates ``body`` in place; ``prompt_versions``
    keeps the append-only history of every save/revert. ``sha256`` is the hash
    of ``body`` and powers the editor's optimistic-concurrency check.
    """

    __tablename__ = "prompt_templates"
    __table_args__ = (
        Index("prompt_templates_category_idx", "category"),
        {"schema": "content_tool"},
    )

    template_id: Mapped[str] = mapped_column(String, primary_key=True)
    category: Mapped[str] = mapped_column(String, nullable=False)
    filename: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(String, nullable=False)
    sha256: Mapped[str] = mapped_column(String, nullable=False)
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        onupdate=text("now()"),
    )
    updated_by: Mapped[str | None] = mapped_column(String)


class SourcePolicyRecord(Base):
    """Live source-policy document — the runtime source of truth for the
    ``{source_policy_block}`` prompt text AND citation-domain evaluation.

    One singleton row (``policy_id='default'``). ``body`` holds the canonical
    compact JSON of the ``{deny, prefer, community_exception}`` structure;
    ``sha256`` is the hash of ``body`` and powers the editor's
    optimistic-concurrency check. ``source_policy_versions`` keeps the
    append-only history of every save/revert.
    """

    __tablename__ = "source_policy"
    __table_args__ = ({"schema": "content_tool"},)

    policy_id: Mapped[str] = mapped_column(String, primary_key=True)
    body: Mapped[str] = mapped_column(String, nullable=False)
    sha256: Mapped[str] = mapped_column(String, nullable=False)
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        onupdate=text("now()"),
    )
    updated_by: Mapped[str | None] = mapped_column(String)


class SourcePolicyVersion(Base):
    """Immutable history row for every source-policy save or revert.

    Mirrors :class:`PromptVersion`. ``parent_sha256`` chains rows so the lineage
    is recoverable even if ``saved_at`` ties.
    """

    __tablename__ = "source_policy_versions"
    __table_args__ = (
        Index("source_policy_versions_policy_idx", "policy_id", "saved_at"),
        {"schema": "content_tool"},
    )

    version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    policy_id: Mapped[str] = mapped_column(String, nullable=False)
    sha256: Mapped[str] = mapped_column(String, nullable=False)
    parent_sha256: Mapped[str | None] = mapped_column(String)
    body: Mapped[str] = mapped_column(String, nullable=False)
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    saved_by: Mapped[str] = mapped_column(String, nullable=False)
    saved_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    kind: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'save'")
    )


from content_tool.db.persona_model import Persona  # noqa: E402
from content_tool.db.topic_batch_model import (  # noqa: E402
    TopicBatch,
    TopicCandidate,
)

__all__ = ["Persona", "TopicBatch", "TopicCandidate"]
