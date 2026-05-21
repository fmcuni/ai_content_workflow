"""fetched_articles + outlines

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"


def upgrade() -> None:
    op.create_table(
        "fetched_articles",
        sa.Column("run_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("fetched_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("wp_post_id", sa.Integer),
        sa.Column("wp_categories", postgresql.JSONB),
        sa.Column("raw_html", sa.String),
        sa.Column("markdown", sa.String, nullable=False),
        schema="content_tool",
    )
    op.create_table(
        "outlines",
        sa.Column("run_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.Column("edited_by_human", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("human_edits", postgresql.JSONB),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("outlines", schema="content_tool")
    op.drop_table("fetched_articles", schema="content_tool")
