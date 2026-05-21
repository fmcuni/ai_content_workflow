"""renders

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"


def upgrade() -> None:
    op.create_table(
        "renders",
        sa.Column("render_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("draft_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("seo_title", sa.String, nullable=False),
        sa.Column("meta_description", sa.String, nullable=False),
        sa.Column("html_body", sa.String, nullable=False),
        sa.Column("faq_schema_jsonld", postgresql.JSONB),
        sa.Column("excerpt_suggestion", sa.String),
        sa.Column("slug_suggestion", sa.String),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("renders", schema="content_tool")
