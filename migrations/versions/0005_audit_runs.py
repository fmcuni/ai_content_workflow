"""audit_runs

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"


def upgrade() -> None:
    op.create_table(
        "audit_runs",
        sa.Column("audit_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("draft_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"),
                  nullable=False, unique=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("overall_pass", sa.Boolean, nullable=False),
        sa.Column("severity_high", sa.Integer, server_default="0"),
        sa.Column("severity_medium", sa.Integer, server_default="0"),
        sa.Column("severity_low", sa.Integer, server_default="0"),
        sa.Column("llm_findings", postgresql.JSONB, nullable=False),
        sa.Column("deterministic_findings", postgresql.JSONB, nullable=False),
        sa.Column("tokens_in", sa.Integer),
        sa.Column("tokens_out", sa.Integer),
        sa.Column("latency_ms", sa.Integer),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("audit_runs", schema="content_tool")
