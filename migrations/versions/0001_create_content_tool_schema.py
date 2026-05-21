"""create content_tool schema with runs + gap_analyses

Revision ID: 0001
Revises:
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS content_tool")

    op.create_table(
        "runs",
        sa.Column("run_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_by", sa.String, nullable=False),
        sa.Column("status", sa.String, nullable=False),
        sa.Column("article_url", sa.String, nullable=False),
        sa.Column("topic", sa.String, nullable=False),
        sa.Column("keywords", postgresql.JSONB, nullable=False),
        sa.Column("mode", sa.String, nullable=False),
        sa.Column("edit_note", sa.String),
        sa.Column("acf_adv_id", sa.Integer, nullable=False),
        sa.Column("acf_widget_id", sa.Integer, nullable=False),
        sa.Column("persona", sa.String, nullable=False),
        sa.Column("topic_category", sa.String),
        sa.Column("today_date", sa.Date, nullable=False),
        sa.Column("chosen_route", sa.String),
        sa.Column("iteration_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("hitl_1_decision", sa.String),
        sa.Column("hitl_1_notes", sa.String),
        sa.Column("hitl_2_decision", sa.String),
        sa.Column("hitl_2_notes", sa.String),
        sa.Column("approved_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("approved_by", sa.String),
        sa.Column("wp_author_id", sa.Integer),
        sa.Column("wp_category_ids", postgresql.JSONB),
        sa.Column("wp_tag_ids", postgresql.JSONB),
        sa.Column("wp_featured_media_id", sa.Integer),
        sa.Column("wp_slug", sa.String),
        sa.Column("wp_excerpt", sa.String),
        sa.Column("wp_publish_status", sa.String),
        sa.Column("wp_publish_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("wp_pushed_post_id", sa.Integer),
        sa.Column("wp_pushed_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("wp_push_error", postgresql.JSONB),
        sa.Column("error", postgresql.JSONB),
        schema="content_tool",
    )
    op.create_index("runs_status_idx", "runs", ["status"], schema="content_tool")
    op.create_index("runs_created_at_idx", "runs", [sa.text("created_at DESC")], schema="content_tool")

    op.create_table(
        "gap_analyses",
        sa.Column("run_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("model", sa.String, nullable=False),
        sa.Column("thinking_level", sa.String, nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.Column("tokens_in", sa.Integer),
        sa.Column("tokens_out", sa.Integer),
        sa.Column("thinking_tokens", sa.Integer),
        sa.Column("latency_ms", sa.Integer),
        sa.Column("raw_response", postgresql.JSONB),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("gap_analyses", schema="content_tool")
    op.drop_table("runs", schema="content_tool")
    op.execute("DROP SCHEMA content_tool CASCADE")
