-- Bowtie content_tool seed data
--
-- Applied automatically by `supabase db reset` after the baseline migration.
-- Previously inserted by Alembic migrations 0009 + 0010 + 0011 (now retired).
-- Idempotent: re-running is safe; existing rows are preserved.

INSERT INTO content_tool.personas (
    slug,
    name,
    voice_rules,
    banned_terms,
    required_phrasings,
    disclaimer_templates,
    tone_examples,
    glossary
) VALUES (
    'bowtie-editor',
    'Bowtie 編輯',
    '["用字自然、清晰、專業", "避免空泛套話與過度推銷", "避免內地用語（信息、软件、网络、视频）", "優先使用香港讀者熟悉的詞彙與例子"]'::jsonb,
    '["信息", "软件", "网络", "视频", "优势", "注释"]'::jsonb,
    '["自願醫保", "強積金", "危疾保", "扣稅"]'::jsonb,
    '{"medical": {"condition": "", "disclaimer": "本文僅供參考，並非醫療建議。如有疑問請諮詢註冊醫生。"}, "insurance": {"condition": "", "disclaimer": "本文僅供參考，實際保障條款以保單為準。"}}'::jsonb,
    '{"bad": ["本文将为您详细介绍...", "希望本文能够帮助到大家。"], "good": ["如果你最近開始留意自願醫保扣稅，以下幾點值得先弄清楚...", "簡單來說，第三期的存活率比想像中高，但前提是要..."]}'::jsonb,
    '[]'::jsonb
) ON CONFLICT (slug) DO NOTHING;
