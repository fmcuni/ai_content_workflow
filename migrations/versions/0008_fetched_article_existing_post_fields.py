"""fetched_article_existing_post_fields

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-26
"""

import sqlalchemy as sa

from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade() -> None:
    op.add_column(
        "fetched_articles",
        sa.Column("wp_author_id", sa.Integer(), nullable=True),
        schema="content_tool",
    )
    op.add_column(
        "fetched_articles",
        sa.Column("wp_slug", sa.Text(), nullable=True),
        schema="content_tool",
    )
    op.add_column(
        "fetched_articles",
        sa.Column("wp_link", sa.Text(), nullable=True),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_column("fetched_articles", "wp_link", schema="content_tool")
    op.drop_column("fetched_articles", "wp_slug", schema="content_tool")
    op.drop_column("fetched_articles", "wp_author_id", schema="content_tool")
