"""topic batches + candidates + runs create-mode columns

Adds the parent/child tables that back Front II ("Expand Topics") and the
columns on ``runs`` that let the existing production pipeline accept a
create-mode entry alongside the refresh-mode entry. See
``docs/superpowers/plans/2026-05-26-topic-expansion-and-create-article.md``
Task 1 for the full schema rationale.

Revision ID: 0013
Revises: 0012
Create Date: 2026-05-26
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0013"
down_revision = "0012"


def upgrade() -> None:
    op.create_table(
        "topic_batches",
        sa.Column(
            "batch_id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("created_by", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("research_theme", sa.Text, nullable=False),
        sa.Column("target_audience", sa.Text, nullable=False),
        sa.Column("topic_count", sa.Integer, nullable=False),
        sa.Column("keywords_per_topic", sa.Integer, nullable=False),
        sa.Column(
            "must_cover",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "must_avoid",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("priority_focus", sa.Text),
        sa.Column("notes", sa.Text),
        sa.Column("persona_default", sa.Text),
        sa.Column("acf_adv_id_default", sa.Integer),
        sa.Column("acf_widget_id_default", sa.Integer),
        sa.Column(
            "cost_cents",
            sa.Integer,
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("last_error", sa.Text),
        schema="content_tool",
    )
    op.create_index(
        "topic_batches_created_at_idx",
        "topic_batches",
        [sa.text("created_at DESC")],
        schema="content_tool",
    )

    op.create_table(
        "topic_candidates",
        sa.Column(
            "candidate_id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "batch_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "content_tool.topic_batches.batch_id", ondelete="CASCADE"
            ),
            nullable=False,
        ),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column(
            "status",
            sa.Text,
            nullable=False,
            server_default=sa.text("'candidate'"),
        ),
        sa.Column("topic", sa.Text, nullable=False),
        sa.Column("keywords", postgresql.JSONB, nullable=False),
        sa.Column("original_topic", sa.Text, nullable=False),
        sa.Column("original_keywords", postgresql.JSONB, nullable=False),
        sa.Column("existing", sa.Text),
        sa.Column("existing_note", sa.Text),
        sa.Column("existing_url", sa.Text),
        sa.Column("hot_topic", sa.Text),
        sa.Column("hot_topic_note", sa.Text),
        sa.Column("persona_slug", sa.Text),
        sa.Column("acf_adv_id", sa.Integer),
        sa.Column("acf_widget_id", sa.Integer),
        sa.Column("operator_note", sa.Text),
        sa.Column("promote_mode", sa.Text),
        sa.Column(
            "promoted_run_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("content_tool.runs.run_id"),
        ),
        sa.Column("last_error", sa.Text),
        sa.Column("last_edited_by", sa.Text),
        sa.Column("last_edited_at", sa.TIMESTAMP(timezone=True)),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        schema="content_tool",
    )
    op.create_index(
        "topic_candidates_batch_id_idx",
        "topic_candidates",
        ["batch_id"],
        schema="content_tool",
    )
    op.create_index(
        "topic_candidates_promoted_run_id_idx",
        "topic_candidates",
        ["promoted_run_id"],
        schema="content_tool",
    )

    # Extend runs for create-mode support.
    op.add_column(
        "runs",
        sa.Column(
            "start_mode",
            sa.Text,
            nullable=False,
            server_default=sa.text("'refresh'"),
        ),
        schema="content_tool",
    )
    op.add_column(
        "runs",
        sa.Column(
            "topic_candidate_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("content_tool.topic_candidates.candidate_id"),
        ),
        schema="content_tool",
    )
    op.add_column(
        "runs",
        sa.Column("target_audience", sa.Text),
        schema="content_tool",
    )
    op.alter_column(
        "runs",
        "article_url",
        nullable=True,
        schema="content_tool",
    )
    op.create_index(
        "runs_topic_candidate_id_idx",
        "runs",
        ["topic_candidate_id"],
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_index(
        "runs_topic_candidate_id_idx",
        table_name="runs",
        schema="content_tool",
    )
    op.alter_column(
        "runs",
        "article_url",
        nullable=False,
        schema="content_tool",
    )
    op.drop_column("runs", "target_audience", schema="content_tool")
    op.drop_column("runs", "topic_candidate_id", schema="content_tool")
    op.drop_column("runs", "start_mode", schema="content_tool")

    op.drop_index(
        "topic_candidates_promoted_run_id_idx",
        table_name="topic_candidates",
        schema="content_tool",
    )
    op.drop_index(
        "topic_candidates_batch_id_idx",
        table_name="topic_candidates",
        schema="content_tool",
    )
    op.drop_table("topic_candidates", schema="content_tool")

    op.drop_index(
        "topic_batches_created_at_idx",
        table_name="topic_batches",
        schema="content_tool",
    )
    op.drop_table("topic_batches", schema="content_tool")
