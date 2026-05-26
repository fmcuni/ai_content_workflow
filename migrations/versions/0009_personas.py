"""personas

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-26
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0009"
down_revision = "0008"

# Inline snapshot of config/personas/bowtie-editor.yaml taken 2026-05-26.
# Inlining makes this migration a self-contained historical record that does
# not depend on the file being present at upgrade time.
_BOWTIE_EDITOR_SEED = {
    "name": "Bowtie 編輯",
    "voice_rules": [
        "用字自然、清晰、專業",
        "避免空泛套話與過度推銷",
        "避免內地用語（信息、软件、网络、视频）",
        "優先使用香港讀者熟悉的詞彙與例子",
    ],
    "banned_terms": [
        "信息",
        "软件",
        "网络",
        "视频",
        "优势",
        "注释",
    ],
    "required_phrasings": [
        "自願醫保",
        "強積金",
        "危疾保",
        "扣稅",
    ],
    "disclaimer_templates": {
        "medical": "本文僅供參考，並非醫療建議。如有疑問請諮詢註冊醫生。",
        "insurance": "本文僅供參考，實際保障條款以保單為準。",
    },
    "tone_examples": {
        "good": [
            "如果你最近開始留意自願醫保扣稅，以下幾點值得先弄清楚...",
            "簡單來說，第三期的存活率比想像中高，但前提是要...",
        ],
        "bad": [
            "本文将为您详细介绍...",
            "希望本文能够帮助到大家。",
        ],
    },
}


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

    seed = _BOWTIE_EDITOR_SEED
    op.execute(
        sa.text(
            "INSERT INTO content_tool.personas "
            "(slug, name, voice_rules, banned_terms, required_phrasings, "
            " disclaimer_templates, tone_examples) "
            "VALUES (:slug, :name, :vr, :bt, :rp, :dt, :te) "
            "ON CONFLICT (slug) DO NOTHING"
        ).bindparams(
            sa.bindparam("slug", "bowtie-editor"),
            sa.bindparam("name", seed["name"]),
            sa.bindparam("vr", seed["voice_rules"], type_=postgresql.JSONB),
            sa.bindparam("bt", seed["banned_terms"], type_=postgresql.JSONB),
            sa.bindparam("rp", seed["required_phrasings"], type_=postgresql.JSONB),
            sa.bindparam("dt", seed["disclaimer_templates"], type_=postgresql.JSONB),
            sa.bindparam("te", seed["tone_examples"], type_=postgresql.JSONB),
        )
    )


def downgrade() -> None:
    op.drop_table("personas", schema="content_tool")
