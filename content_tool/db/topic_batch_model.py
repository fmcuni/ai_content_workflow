from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import TIMESTAMP, Boolean, ForeignKey, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from content_tool.db.base import Base


class TopicBatch(Base):
    """Parent row for a Front II "Expand Topics" brief.

    Lifecycle ``status`` values: ``pending``, ``generating``, ``analysing``,
    ``ready_for_review``, ``partially_promoted``, ``done``, ``failed``.
    """

    __tablename__ = "topic_batches"
    __table_args__ = (
        Index("topic_batches_created_at_idx", text("created_at DESC")),
        {"schema": "content_tool"},
    )

    batch_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        onupdate=text("now()"),
        nullable=False,
    )
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    research_theme: Mapped[str] = mapped_column(Text, nullable=False)
    target_audience: Mapped[str] = mapped_column(Text, nullable=False)
    topic_count: Mapped[int] = mapped_column(Integer, nullable=False)
    keywords_per_topic: Mapped[int] = mapped_column(Integer, nullable=False)
    must_cover: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    must_avoid: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    priority_focus: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    persona_default: Mapped[str | None] = mapped_column(Text)
    acf_adv_id_default: Mapped[int | None] = mapped_column(Integer)
    acf_widget_id_default: Mapped[int | None] = mapped_column(Integer)
    # Carried onto every run promoted from this batch (see Run.auto_accept_hitl1).
    auto_accept_hitl1_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    cost_cents: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    last_error: Mapped[str | None] = mapped_column(Text)


class TopicCandidate(Base):
    """One generated topic inside a batch.

    ``status`` values: ``candidate``, ``promoted``, ``skipped``, ``errored``.
    ``existing`` / ``hot_topic`` are nullable while analysis is in flight or
    if the verdict call errored out after retries.
    """

    __tablename__ = "topic_candidates"
    __table_args__ = (
        Index("topic_candidates_batch_id_idx", "batch_id"),
        Index("topic_candidates_promoted_run_id_idx", "promoted_run_id"),
        {"schema": "content_tool"},
    )

    candidate_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    batch_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(
            "content_tool.topic_batches.batch_id", ondelete="CASCADE"
        ),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'candidate'")
    )
    topic: Mapped[str] = mapped_column(Text, nullable=False)
    keywords: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    original_topic: Mapped[str] = mapped_column(Text, nullable=False)
    original_keywords: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    existing: Mapped[str | None] = mapped_column(Text)
    existing_note: Mapped[str | None] = mapped_column(Text)
    existing_url: Mapped[str | None] = mapped_column(Text)
    hot_topic: Mapped[str | None] = mapped_column(Text)
    hot_topic_note: Mapped[str | None] = mapped_column(Text)
    # Dedup stage-1 diagnostics (see content_tool.agents.topic_existing_search
    # Stage1Diagnostics). Explains why ``existing`` was decided — especially
    # empty-candidate "no" verdicts. NULL while analysis is in flight or if the
    # dedup call errored before stage-1 produced diagnostics.
    existing_search_debug: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    persona_slug: Mapped[str | None] = mapped_column(Text)
    acf_adv_id: Mapped[int | None] = mapped_column(Integer)
    acf_widget_id: Mapped[int | None] = mapped_column(Integer)
    operator_note: Mapped[str | None] = mapped_column(Text)
    promote_mode: Mapped[str | None] = mapped_column(Text)
    promoted_run_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("content_tool.runs.run_id")
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    last_edited_by: Mapped[str | None] = mapped_column(Text)
    last_edited_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        onupdate=text("now()"),
        nullable=False,
    )
