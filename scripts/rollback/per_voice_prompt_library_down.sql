-- ============================================================================
-- ROLLBACK (DOWN) MIGRATION — Per-Voice Prompt Library & Source Policy
-- Reverses: supabase/migrations/20260604172254_per_voice_prompt_library.sql
--           supabase/migrations/20260605000001_reseed_prompt_templates_shared.sql
-- ============================================================================
--
-- ⚠️  STAGED, NOT AUTO-APPLIED. This file deliberately lives OUTSIDE
--     supabase/migrations/ so `supabase db push` never runs it. Apply by hand
--     ONLY as part of a coordinated full rollback (see the runbook:
--     docs/superpowers/plans/2026-06-06-per-voice-rollback-runbook.md).
--
-- ⚠️  LOSSY. Restoring the pre-feature (singleton) schema discards all per-voice
--     data created since rollout:
--       - every prompt_templates row with voice_slug <> '__shared__'
--       - every prompt_versions / source_policy_versions row with
--         voice_slug <> '__shared__'
--       - every source_policy row with voice_slug <> '__shared__'
--     The '__shared__' seed-of-record (canonical agent/partial set + judges, and
--     the shared source policy) is what survives and becomes the singleton again.
--
-- ⚠️  PREFER FIX-FORWARD. Only use this if the deployed CODE must be reverted to
--     the pre-feature Workers versions, which read the OLD singleton schema
--     (source_policy.policy_id='default', prompt_templates PK=template_id) and
--     would otherwise error against the new columns.
--
-- ✓  Dry-run rehearsed 2026-06-06 on the local Supabase DB (per-voice schema)
--     inside a rolled-back transaction: all statements executed, the assertion
--     block passed ("rollback OK..."), and nothing persisted. Still REHEARSE
--     against a prod COPY/PITR clone (with real per-voice data + populated
--     version tables) before applying to prod — local has no personas.
--
-- Runs atomically; aborts and rolls back if any assertion fails.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 4'. source_policy_versions — drop per-voice history scoping
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS content_tool.source_policy_versions_voice_idx;
DELETE FROM content_tool.source_policy_versions WHERE voice_slug <> '__shared__';
ALTER TABLE content_tool.source_policy_versions DROP COLUMN IF EXISTS voice_slug;

-- ---------------------------------------------------------------------------
-- 3'. source_policy — per-voice -> singleton (policy_id='default')
-- ---------------------------------------------------------------------------
-- Discard per-voice policies; keep the shared seed as the singleton body.
DELETE FROM content_tool.source_policy WHERE voice_slug <> '__shared__';

ALTER TABLE content_tool.source_policy
    ADD COLUMN IF NOT EXISTS policy_id character varying;
UPDATE content_tool.source_policy SET policy_id = 'default';

ALTER TABLE content_tool.source_policy DROP CONSTRAINT IF EXISTS source_policy_pkey;
ALTER TABLE content_tool.source_policy ALTER COLUMN policy_id SET NOT NULL;
ALTER TABLE content_tool.source_policy ADD CONSTRAINT source_policy_pkey PRIMARY KEY (policy_id);
ALTER TABLE content_tool.source_policy DROP COLUMN IF EXISTS voice_slug;

-- ---------------------------------------------------------------------------
-- 2'. prompt_versions — drop per-voice history scoping
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS content_tool.prompt_versions_voice_idx;
DELETE FROM content_tool.prompt_versions WHERE voice_slug <> '__shared__';
ALTER TABLE content_tool.prompt_versions DROP COLUMN IF EXISTS voice_slug;

-- ---------------------------------------------------------------------------
-- 1'. prompt_templates — per-voice -> singleton (PK = template_id)
-- ---------------------------------------------------------------------------
-- Discard per-voice copies; keep the canonical '__shared__' set + judges.
DELETE FROM content_tool.prompt_templates WHERE voice_slug <> '__shared__';

ALTER TABLE content_tool.prompt_templates DROP CONSTRAINT IF EXISTS prompt_templates_pkey;
DROP INDEX IF EXISTS content_tool.prompt_templates_voice_idx;
ALTER TABLE content_tool.prompt_templates ADD CONSTRAINT prompt_templates_pkey PRIMARY KEY (template_id);
ALTER TABLE content_tool.prompt_templates DROP COLUMN IF EXISTS voice_slug;

-- ---------------------------------------------------------------------------
-- Post-rollback assertions (abort if the old shape was not restored)
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
    sp_rows        integer;
    has_voice_col  integer;
    tpl_dupe_ids   integer;
BEGIN
    SELECT count(*) INTO sp_rows FROM content_tool.source_policy;
    IF sp_rows <> 1 THEN
        RAISE EXCEPTION 'rollback: source_policy must be a singleton, found % row(s)', sp_rows;
    END IF;

    SELECT count(*) INTO has_voice_col
    FROM information_schema.columns
    WHERE table_schema = 'content_tool'
      AND column_name = 'voice_slug'
      AND table_name IN ('prompt_templates','prompt_versions','source_policy','source_policy_versions');
    IF has_voice_col <> 0 THEN
        RAISE EXCEPTION 'rollback: voice_slug still present on % table(s)', has_voice_col;
    END IF;

    -- template_id must once again be unique (old singleton PK precondition).
    SELECT count(*) INTO tpl_dupe_ids FROM (
        SELECT template_id FROM content_tool.prompt_templates
        GROUP BY template_id HAVING count(*) > 1
    ) d;
    IF tpl_dupe_ids > 0 THEN
        RAISE EXCEPTION 'rollback: % duplicate template_id(s) remain', tpl_dupe_ids;
    END IF;

    RAISE NOTICE 'rollback OK: singleton source_policy + template_id PK restored; voice_slug dropped';
END
$assert$;

-- Inspect the NOTICE above. If correct, COMMIT. To abort, run ROLLBACK instead.
COMMIT;

-- After COMMIT, mark the forward migrations reverted so `supabase db push`
-- agrees with reality (run from the repo, NOT inside this transaction):
--   supabase migration repair --status reverted 20260605000001
--   supabase migration repair --status reverted 20260604172254
