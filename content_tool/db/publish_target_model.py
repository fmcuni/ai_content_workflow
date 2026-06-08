from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import TIMESTAMP, Boolean, String, text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from content_tool.db.base import Base


class PublishTarget(Base):
    """A CMS publish destination (Phase 1: WordPress instances only).

    Holds non-secret config only. The actual base URL + credentials live in the
    environment under the ``auth_ref`` prefix (``{auth_ref}_BASE_URL`` /
    ``_USERNAME`` / ``_APP_PASSWORD``) and are resolved at publish time — never
    stored in the database.
    """

    __tablename__ = "publish_targets"
    __table_args__ = {"schema": "content_tool"}  # noqa: RUF012

    publish_target_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    auth_ref: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'active'")
    )
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
