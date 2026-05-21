"""compliance_log

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-22
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0006"
down_revision = "0005"


def upgrade() -> None:
    op.create_table(
        "compliance_log",
        sa.Column("log_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "run_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("content_tool.runs.run_id"),
            unique=True,
            nullable=False,
        ),
        sa.Column("persisted_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("persona", sa.String, nullable=False),
        sa.Column("article_url", sa.String, nullable=False),
        sa.Column("wp_pushed_post_id", sa.Integer),
        sa.Column("chosen_route", sa.String, nullable=False),
        sa.Column("sources_cited", sa.String, nullable=False),
        sa.Column("sources_denied", sa.String),
        sa.Column("audit_overall_pass", sa.Boolean, nullable=False),
        sa.Column("audit_severity_summary", postgresql.JSONB, nullable=False),
        sa.Column("approver_email", sa.String, nullable=False),
        sa.Column("iteration_count", sa.Integer),
        sa.Column("gemini_model", sa.String, nullable=False),
        sa.Column("total_tokens", sa.Integer),
        sa.Column("est_cost_usd_cents", sa.Integer),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("compliance_log", schema="content_tool")
