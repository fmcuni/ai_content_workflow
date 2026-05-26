"""personas disclaimer condition

Migrates personas.disclaimer_templates JSONB from
    {"name": "body text"}
to
    {"name": {"condition": "", "disclaimer": "body text"}}

Idempotent: rows already in the new shape are left alone.

Revision ID: 0011
Revises: 0010
Create Date: 2026-05-26
"""

import sqlalchemy as sa

from alembic import op

revision = "0011"
down_revision = "0010"


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE content_tool.personas
            SET disclaimer_templates = (
                SELECT jsonb_object_agg(
                    key,
                    CASE
                        WHEN jsonb_typeof(value) = 'string'
                            THEN jsonb_build_object('condition', '', 'disclaimer', value)
                        ELSE value
                    END
                )
                FROM jsonb_each(disclaimer_templates)
            )
            WHERE disclaimer_templates <> '{}'::jsonb
              AND EXISTS (
                SELECT 1
                FROM jsonb_each(disclaimer_templates) e
                WHERE jsonb_typeof(e.value) = 'string'
              )
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE content_tool.personas
            SET disclaimer_templates = (
                SELECT jsonb_object_agg(
                    key,
                    CASE
                        WHEN jsonb_typeof(value) = 'object'
                            THEN COALESCE(value->'disclaimer', to_jsonb(''::text))
                        ELSE value
                    END
                )
                FROM jsonb_each(disclaimer_templates)
            )
            WHERE disclaimer_templates <> '{}'::jsonb
              AND EXISTS (
                SELECT 1
                FROM jsonb_each(disclaimer_templates) e
                WHERE jsonb_typeof(e.value) = 'object'
              )
            """
        )
    )
