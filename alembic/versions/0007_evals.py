"""evals

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-22
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    op.create_table(
        "evals",
        sa.Column("eval_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("ran_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("metric", sa.String, nullable=False),
        sa.Column("fixture_id", sa.String, nullable=False),
        sa.Column("run_id", postgresql.UUID(as_uuid=True)),
        sa.Column("score", sa.Numeric),
        sa.Column("pass", sa.Boolean, server_default=sa.text("false")),
        sa.Column("judge_notes", postgresql.JSONB),
        sa.Column("commit_sha", sa.String, nullable=False),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("evals", schema="content_tool")
