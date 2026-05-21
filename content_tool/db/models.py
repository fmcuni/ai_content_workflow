from datetime import date, datetime
from uuid import UUID, uuid4

from sqlalchemy import JSON, TIMESTAMP, ForeignKey, Index, String, text  # noqa: F401
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
