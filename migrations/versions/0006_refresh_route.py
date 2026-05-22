"""refresh route: articles + refresh_evaluations + runs cols

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-22
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "articles",
        sa.Column(
            "article_id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("article_url", sa.Text, nullable=False),
        sa.Column("wp_post_id", sa.Integer),
        sa.Column("topic", sa.Text),
        sa.Column("persona", sa.Text),
        sa.Column("topic_category", sa.Text),
        sa.Column(
            "first_seen_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("last_persisted_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("next_scan_due_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("dismissed_until", sa.TIMESTAMP(timezone=True)),
        sa.Column("dismissed_by", sa.Text),
        sa.Column("dismissed_reason", sa.Text),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema="content_tool",
    )
    op.create_index(
        "articles_article_url_uidx",
        "articles",
        ["article_url"],
        unique=True,
        schema="content_tool",
    )
    op.create_index(
        "articles_next_scan_due_idx",
        "articles",
        ["next_scan_due_at"],
        postgresql_where=sa.text("dismissed_until IS NULL"),
        schema="content_tool",
    )
    op.create_index(
        "articles_wp_post_id_idx",
        "articles",
        ["wp_post_id"],
        postgresql_where=sa.text("wp_post_id IS NOT NULL"),
        schema="content_tool",
    )

    op.create_table(
        "refresh_evaluations",
        sa.Column(
            "evaluation_id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "article_id",
            UUID(as_uuid=True),
            sa.ForeignKey("content_tool.articles.article_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "evaluated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("scanner_version", sa.Text, nullable=False),
        sa.Column("trigger_source", sa.Text, nullable=False),
        sa.Column("age_days", sa.Integer, nullable=False),
        sa.Column("fetched_html_hash", sa.Text),
        sa.Column("deterministic_findings", JSONB, nullable=False),
        sa.Column("llm_findings", JSONB),
        sa.Column("llm_skipped_reason", sa.Text),
        sa.Column("staleness_score", sa.Numeric(4, 2), nullable=False),
        sa.Column("recommended_action", sa.Text, nullable=False),
        sa.Column(
            "outcome",
            sa.Text,
            nullable=False,
            server_default=sa.text("'open'"),
        ),
        sa.Column(
            "resulting_run_id",
            UUID(as_uuid=True),
            sa.ForeignKey("content_tool.runs.run_id"),
        ),
        sa.Column("outcome_set_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("outcome_set_by", sa.Text),
        sa.Column("tokens_in", sa.Integer),
        sa.Column("tokens_out", sa.Integer),
        sa.Column("est_cost_usd_cents", sa.Integer),
        sa.Column("latency_ms", sa.Integer),
        schema="content_tool",
    )
    op.create_index(
        "refresh_evals_article_evaluated_idx",
        "refresh_evaluations",
        ["article_id", sa.text("evaluated_at DESC")],
        schema="content_tool",
    )
    op.create_index(
        "refresh_evals_open_idx",
        "refresh_evaluations",
        ["recommended_action", "outcome"],
        postgresql_where=sa.text("outcome = 'open' AND recommended_action = 'refresh'"),
        schema="content_tool",
    )

    op.add_column(
        "runs",
        sa.Column(
            "article_id",
            UUID(as_uuid=True),
            sa.ForeignKey("content_tool.articles.article_id"),
        ),
        schema="content_tool",
    )
    op.add_column(
        "runs",
        sa.Column(
            "triggered_by_evaluation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("content_tool.refresh_evaluations.evaluation_id"),
        ),
        schema="content_tool",
    )
    op.create_index(
        "runs_article_id_idx",
        "runs",
        ["article_id"],
        schema="content_tool",
    )

    # Backfill: one Article per distinct runs.article_url.
    # Note: compliance_log is not in this migration chain (it lives in a
    # separate alembic/ directory), so last_persisted_at is left NULL here.
    # wp_post_id is sourced from fetched_articles which is in this chain.
    op.execute("""
        INSERT INTO content_tool.articles
            (article_url, wp_post_id, topic, persona, topic_category,
             first_seen_at, last_persisted_at, next_scan_due_at)
        SELECT
            article_url,
            MAX(wp_post_id),
            MAX(topic),
            MAX(persona),
            MAX(topic_category),
            MIN(first_seen),
            NULL,
            MIN(first_seen) + INTERVAL '30 days'
        FROM (
            SELECT
                r.article_url,
                fa.wp_post_id,
                r.topic,
                r.persona,
                r.topic_category,
                r.created_at AS first_seen
            FROM content_tool.runs r
            LEFT JOIN content_tool.fetched_articles fa ON fa.run_id = r.run_id
        ) src
        GROUP BY article_url
        ON CONFLICT (article_url) DO NOTHING;
    """)
    op.execute("""
        UPDATE content_tool.runs r
        SET article_id = a.article_id
        FROM content_tool.articles a
        WHERE a.article_url = r.article_url
          AND r.article_id IS NULL;
    """)


def downgrade() -> None:
    op.drop_index("runs_article_id_idx", table_name="runs", schema="content_tool")
    op.drop_column("runs", "triggered_by_evaluation_id", schema="content_tool")
    op.drop_column("runs", "article_id", schema="content_tool")
    op.drop_index(
        "refresh_evals_open_idx",
        table_name="refresh_evaluations",
        schema="content_tool",
    )
    op.drop_index(
        "refresh_evals_article_evaluated_idx",
        table_name="refresh_evaluations",
        schema="content_tool",
    )
    op.drop_table("refresh_evaluations", schema="content_tool")
    op.drop_index(
        "articles_wp_post_id_idx",
        table_name="articles",
        schema="content_tool",
    )
    op.drop_index(
        "articles_next_scan_due_idx",
        table_name="articles",
        schema="content_tool",
    )
    op.drop_index(
        "articles_article_url_uidx",
        table_name="articles",
        schema="content_tool",
    )
    op.drop_table("articles", schema="content_tool")
