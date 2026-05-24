"""hitl2_comments_iteration

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-24
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    op.add_column(
        "runs",
        sa.Column("hitl_2_comments", postgresql.JSONB(), nullable=True),
        schema="content_tool",
    )
    op.add_column(
        "runs",
        sa.Column(
            "hitl_2_iteration",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_column("runs", "hitl_2_iteration", schema="content_tool")
    op.drop_column("runs", "hitl_2_comments", schema="content_tool")
