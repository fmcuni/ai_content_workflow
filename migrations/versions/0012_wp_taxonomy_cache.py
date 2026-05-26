"""wp users / categories cache

Adds two small lookup tables synced periodically from WordPress so the
HITL-2 reviewer dropdowns work even when the WP REST list endpoints are
blocked by CloudFront/WAF.

Revision ID: 0012
Revises: 0011
Create Date: 2026-05-26
"""

import sqlalchemy as sa

from alembic import op

revision = "0012"
down_revision = "0011"


def upgrade() -> None:
    op.create_table(
        "wp_users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("slug", sa.String, nullable=False),
        sa.Column(
            "synced_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        schema="content_tool",
    )
    op.create_index(
        "wp_users_name_idx", "wp_users", ["name"], schema="content_tool"
    )

    op.create_table(
        "wp_categories",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("slug", sa.String, nullable=False),
        sa.Column(
            "synced_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        schema="content_tool",
    )
    op.create_index(
        "wp_categories_name_idx", "wp_categories", ["name"], schema="content_tool"
    )


def downgrade() -> None:
    op.drop_index("wp_categories_name_idx", table_name="wp_categories", schema="content_tool")
    op.drop_table("wp_categories", schema="content_tool")
    op.drop_index("wp_users_name_idx", table_name="wp_users", schema="content_tool")
    op.drop_table("wp_users", schema="content_tool")
