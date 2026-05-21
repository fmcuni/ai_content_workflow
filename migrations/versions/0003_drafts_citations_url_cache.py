"""drafts + citations + url_resolution_cache

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"


def upgrade() -> None:
    op.create_table(
        "drafts",
        sa.Column("draft_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("run_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), nullable=False),
        sa.Column("iteration", sa.Integer, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("diagnose", sa.String, nullable=False),
        sa.Column("markup_raw", sa.String, nullable=False),
        sa.Column("final_markup", sa.String),
        sa.Column("citation_intents", postgresql.JSONB, nullable=False),
        sa.Column("grounding_chunks", postgresql.JSONB),
        sa.Column("tokens_in", sa.Integer),
        sa.Column("tokens_out", sa.Integer),
        sa.Column("thinking_tokens", sa.Integer),
        sa.Column("latency_ms", sa.Integer),
        sa.UniqueConstraint("run_id", "iteration"),
        schema="content_tool",
    )
    op.create_table(
        "citations",
        sa.Column("citation_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("draft_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"), nullable=False),
        sa.Column("chunk_idx", sa.Integer),
        sa.Column("vertex_uri", sa.String, nullable=False),
        sa.Column("final_url", sa.String),
        sa.Column("domain", sa.String),
        sa.Column("title", sa.String),
        sa.Column("policy_decision", sa.String, nullable=False),
        sa.Column("denied_reason", sa.String),
        sa.Column("was_displayed", sa.Boolean, server_default=sa.text("false")),
        sa.Column("resolution_error", sa.String),
        sa.Column("resolved_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        schema="content_tool",
    )
    op.create_index("citations_draft_id_idx", "citations", ["draft_id"], schema="content_tool")
    op.create_table(
        "url_resolution_cache",
        sa.Column("vertex_uri", sa.String, primary_key=True),
        sa.Column("final_url", sa.String),
        sa.Column("domain", sa.String),
        sa.Column("resolved_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("error", sa.String),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("url_resolution_cache", schema="content_tool")
    op.drop_table("citations", schema="content_tool")
    op.drop_table("drafts", schema="content_tool")
