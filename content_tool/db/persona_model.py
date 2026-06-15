from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import TIMESTAMP, Boolean, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from content_tool.db.base import Base


class Persona(Base):
    __tablename__ = "personas"
    __table_args__ = {"schema": "content_tool"}  # noqa: RUF012

    persona_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    slug: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    voice_rules: Mapped[list] = mapped_column(JSONB, nullable=False)
    banned_terms: Mapped[list] = mapped_column(JSONB, nullable=False)
    required_phrasings: Mapped[list] = mapped_column(JSONB, nullable=False)
    disclaimer_templates: Mapped[dict] = mapped_column(JSONB, nullable=False)
    tone_examples: Mapped[dict] = mapped_column(JSONB, nullable=False)
    glossary: Mapped[list] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    # Per-voice locale / brand identity (output language, brand name, market,
    # sources/FAQ headings, persona-block label set). Empty {} → HK-ZH defaults
    # (see content_tool.models.persona.VoiceLocale). Migration 20260616000000.
    locale: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    # CMS publish destination for this voice. NULL → fall back to the legacy
    # WP_* env target (see content_tool/publishers/wp_factory.py).
    publish_target_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True))
    is_archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), onupdate=text("now()")
    )
    created_by: Mapped[str | None] = mapped_column(String)
    updated_by: Mapped[str | None] = mapped_column(String)
