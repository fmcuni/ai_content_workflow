"""personas

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-26
"""

from pathlib import Path

import sqlalchemy as sa
import yaml
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0009"
down_revision = "0008"


def upgrade() -> None:
    op.create_table(
        "personas",
        sa.Column("persona_id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("slug", sa.String, nullable=False, unique=True),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("voice_rules", postgresql.JSONB, nullable=False),
        sa.Column("banned_terms", postgresql.JSONB, nullable=False),
        sa.Column("required_phrasings", postgresql.JSONB, nullable=False),
        sa.Column("disclaimer_templates", postgresql.JSONB, nullable=False),
        sa.Column("tone_examples", postgresql.JSONB, nullable=False),
        sa.Column("is_archived", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("created_by", sa.String, nullable=True),
        sa.Column("updated_by", sa.String, nullable=True),
        schema="content_tool",
    )

    # Seed bowtie-editor from the YAML file so existing runs continue to resolve.
    yaml_path = Path(__file__).resolve().parents[2] / "config" / "personas" / "bowtie-editor.yaml"
    raw = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    op.execute(
        sa.text(
            "INSERT INTO content_tool.personas "
            "(slug, name, voice_rules, banned_terms, required_phrasings, "
            " disclaimer_templates, tone_examples) "
            "VALUES (:slug, :name, :vr, :bt, :rp, :dt, :te)"
        ).bindparams(
            sa.bindparam("slug", "bowtie-editor"),
            sa.bindparam("name", raw["name"]),
            sa.bindparam("vr", raw["voice_rules"], type_=postgresql.JSONB),
            sa.bindparam("bt", raw["banned_terms"], type_=postgresql.JSONB),
            sa.bindparam("rp", raw["required_phrasings"], type_=postgresql.JSONB),
            sa.bindparam("dt", raw["disclaimer_templates"], type_=postgresql.JSONB),
            sa.bindparam("te", raw["tone_examples"], type_=postgresql.JSONB),
        )
    )


def downgrade() -> None:
    op.drop_table("personas", schema="content_tool")
