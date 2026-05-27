"""hitl2_snapshots

Creates ``content_tool.hitl2_snapshots`` — the autosave / version-history store
for the HITL_2 galley page. Each row captures the reviewer's working state
(editor body, SEO/WP metadata, overall notes, anchored comments) at a point in
time, written on a 5-minute interval, on page exit, or on tab close. Schema
mirrors ``db/models.Hitl2Snapshot``.

Revision ID: 0015
Revises: 0014
Create Date: 2026-05-27
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0015"
down_revision = "0014"


def upgrade() -> None:
    op.create_table(
        "hitl2_snapshots",
        sa.Column("snapshot_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "run_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
        ),
        sa.Column("created_by", sa.String),
        sa.Column("trigger", sa.String, nullable=False),
        sa.Column("html_body", sa.String, nullable=False),
        sa.Column("seo_title", sa.String),
        sa.Column("meta_description", sa.String),
        sa.Column("notes", sa.String),
        sa.Column("comments", postgresql.JSONB),
        sa.Column("wp_publish_status", sa.String),
        sa.Column("wp_author_id", sa.Integer),
        sa.Column("wp_category_ids", postgresql.JSONB),
        sa.Column("wp_tag_ids", postgresql.JSONB),
        sa.Column("wp_featured_media_id", sa.Integer),
        sa.Column("wp_slug", sa.String),
        sa.Column("wp_excerpt", sa.String),
        sa.Column("wp_publish_at", sa.TIMESTAMP(timezone=True)),
        schema="content_tool",
    )
    op.create_index(
        "hitl2_snapshots_run_created_idx",
        "hitl2_snapshots",
        ["run_id", "created_at"],
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_index(
        "hitl2_snapshots_run_created_idx",
        table_name="hitl2_snapshots",
        schema="content_tool",
    )
    op.drop_table("hitl2_snapshots", schema="content_tool")
