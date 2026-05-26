"""personas glossary

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-26
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0010"
down_revision = "0009"


def upgrade() -> None:
    op.add_column(
        "personas",
        sa.Column(
            "glossary",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_column("personas", "glossary", schema="content_tool")
