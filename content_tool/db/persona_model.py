from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import TIMESTAMP, Boolean, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from content_tool.db.models import Base


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
    is_archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    created_by: Mapped[str | None] = mapped_column(String)
    updated_by: Mapped[str | None] = mapped_column(String)
