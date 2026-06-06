-- Per-Voice Prompt Library & Source Policy (Phase 1: DB migration only).
-- Spec:  docs/superpowers/specs/2026-06-05-per-voice-prompt-library.md
-- Plan:  docs/superpowers/plans/2026-06-05-per-voice-prompt-library.md
--
-- Scopes content_tool.prompt_templates (categories `agent` + `partial`) and
-- content_tool.source_policy PER VOICE (persona slug). Judges stay global.
-- A reserved sentinel voice_slug = '__shared__' denotes global / seed-of-record
-- rows: all judges, plus the canonical agent/partial set that fresh installs
-- start from and that every voice falls back to for a missing template.
--
-- Safe-to-push-first: every new column has a server default, so the currently
-- deployed app code (which does not yet read voice_slug) keeps inserting valid
-- rows during the deploy window. The new-column-reading code ships in later
-- phases, AFTER this migration is applied (CLAUDE.md ordering invariant).
--
-- RLS / grants parity: prompt_templates, prompt_versions, source_policy and
-- source_policy_versions already have table-level GRANTs (GRANT ... ON ALL
-- TABLES, + ALTER DEFAULT PRIVILEGES) and row-level policies (USING (true))
-- for postgres + content_tool_app. Both are column-agnostic, so ADD COLUMN and
-- the PK swaps below are covered automatically — no new policy/grant needed.
--
-- Fresh-install ordering note: on `supabase db reset`, supabase/seed.sql (which
-- inserts the `bowtie-editor` persona) runs AFTER all migrations, so the
-- personas table is empty at this migration's runtime. The CROSS JOIN backfill
-- therefore covers only personas that already exist (the prod `db push` path);
-- a dedicated block seeds the default `bowtie-editor` voice unconditionally so
-- fresh local resets also end with a full per-voice set.

-- ---------------------------------------------------------------------------
-- 1. prompt_templates — per-voice scoping
-- ---------------------------------------------------------------------------

-- Existing rows become the '__shared__' seed-of-record (judges + canonical
-- agent/partial set). The DEFAULT backfills them in place.
ALTER TABLE content_tool.prompt_templates
    ADD COLUMN voice_slug character varying NOT NULL DEFAULT '__shared__';

-- Repoint the primary key from (template_id) to (voice_slug, template_id).
ALTER TABLE content_tool.prompt_templates
    DROP CONSTRAINT prompt_templates_pkey;
ALTER TABLE content_tool.prompt_templates
    ADD CONSTRAINT prompt_templates_pkey PRIMARY KEY (voice_slug, template_id);

CREATE INDEX IF NOT EXISTS prompt_templates_voice_idx
    ON content_tool.prompt_templates USING btree (voice_slug);
-- (prompt_templates_category_idx is retained from 20260529000001.)

-- Backfill: every non-archived persona gets its own editable copy of the
-- canonical agent/partial set. Judges stay '__shared__' (global, never copied).
INSERT INTO content_tool.prompt_templates
    (voice_slug, template_id, category, filename, body, sha256, bytes, updated_by)
SELECT p.slug, t.template_id, t.category, t.filename, t.body, t.sha256, t.bytes,
       'migration:per_voice_prompt_library'
FROM content_tool.personas p
CROSS JOIN content_tool.prompt_templates t
WHERE p.is_archived = false
  AND t.voice_slug = '__shared__'
  AND t.category IN ('agent', 'partial')
ON CONFLICT (voice_slug, template_id) DO NOTHING;

-- Fresh-install safety: guarantee the default seeded voice has the full set
-- even when the personas table is still empty (db reset, seed runs later).
INSERT INTO content_tool.prompt_templates
    (voice_slug, template_id, category, filename, body, sha256, bytes, updated_by)
SELECT 'bowtie-editor', t.template_id, t.category, t.filename, t.body, t.sha256,
       t.bytes, 'migration:per_voice_prompt_library'
FROM content_tool.prompt_templates t
WHERE t.voice_slug = '__shared__'
  AND t.category IN ('agent', 'partial')
ON CONFLICT (voice_slug, template_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. prompt_versions — per-voice history
-- ---------------------------------------------------------------------------

-- Existing history rows belong to the '__shared__' seed lineage (the DEFAULT
-- backfills them); new saves will carry the editing voice in later phases.
ALTER TABLE content_tool.prompt_versions
    ADD COLUMN voice_slug character varying NOT NULL DEFAULT '__shared__';

CREATE INDEX IF NOT EXISTS prompt_versions_voice_idx
    ON content_tool.prompt_versions USING btree (voice_slug, template_id, saved_at);
-- (prompt_versions_template_idx is retained for legacy lookups.)

-- ---------------------------------------------------------------------------
-- 3. source_policy — singleton -> per-voice
-- ---------------------------------------------------------------------------

-- Add the voice key (nullable while we repoint the PK), then promote the
-- existing singleton 'default' row to the '__shared__' seed-of-record.
ALTER TABLE content_tool.source_policy
    ADD COLUMN voice_slug character varying;

UPDATE content_tool.source_policy
    SET voice_slug = '__shared__'
    WHERE policy_id = 'default';

-- Any unexpected non-default rows also fold into the shared seed (defensive).
UPDATE content_tool.source_policy
    SET voice_slug = '__shared__'
    WHERE voice_slug IS NULL;

-- Drop the singleton PK + the now-unused policy_id column (Phase 0 decision:
-- policy_id is dropped, PK repurposed to voice_slug).
ALTER TABLE content_tool.source_policy
    DROP CONSTRAINT source_policy_pkey;
ALTER TABLE content_tool.source_policy
    DROP COLUMN policy_id;

ALTER TABLE content_tool.source_policy
    ALTER COLUMN voice_slug SET NOT NULL;
ALTER TABLE content_tool.source_policy
    ADD CONSTRAINT source_policy_pkey PRIMARY KEY (voice_slug);

-- Backfill one policy row per non-archived persona from the shared seed.
INSERT INTO content_tool.source_policy
    (voice_slug, body, sha256, bytes, updated_by)
SELECT p.slug, s.body, s.sha256, s.bytes, 'migration:per_voice_prompt_library'
FROM content_tool.personas p
CROSS JOIN content_tool.source_policy s
WHERE p.is_archived = false
  AND s.voice_slug = '__shared__'
ON CONFLICT (voice_slug) DO NOTHING;

-- Fresh-install safety: guarantee the default seeded voice has a policy row.
INSERT INTO content_tool.source_policy
    (voice_slug, body, sha256, bytes, updated_by)
SELECT 'bowtie-editor', s.body, s.sha256, s.bytes, 'migration:per_voice_prompt_library'
FROM content_tool.source_policy s
WHERE s.voice_slug = '__shared__'
ON CONFLICT (voice_slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. source_policy_versions — per-voice history
-- ---------------------------------------------------------------------------

-- policy_id is retained here (history label only; no FK to source_policy), and
-- voice_slug defaults existing rows to the '__shared__' seed lineage.
ALTER TABLE content_tool.source_policy_versions
    ADD COLUMN voice_slug character varying NOT NULL DEFAULT '__shared__';

CREATE INDEX IF NOT EXISTS source_policy_versions_voice_idx
    ON content_tool.source_policy_versions USING btree (voice_slug, saved_at);

-- ---------------------------------------------------------------------------
-- 5. Post-migration assertions (prod-push safety net)
-- ---------------------------------------------------------------------------
-- Every non-archived persona that EXISTS at migration time must have the full
-- agent/partial set AND exactly one source-policy row. On fresh `db reset` the
-- personas table is still empty here, so this is a no-op locally; the standalone
-- scripts/check_per_voice_backfill.sql validates the post-seed state instead.
DO $assert$
DECLARE
    shared_set_count integer;
    bad_templates    integer;
    bad_policy       integer;
    persona_count    integer;
BEGIN
    SELECT count(*) INTO shared_set_count
    FROM content_tool.prompt_templates
    WHERE voice_slug = '__shared__' AND category IN ('agent', 'partial');

    SELECT count(*) INTO persona_count
    FROM content_tool.personas WHERE is_archived = false;

    -- personas missing one or more agent/partial templates
    SELECT count(*) INTO bad_templates
    FROM content_tool.personas p
    WHERE p.is_archived = false
      AND (
        SELECT count(*) FROM content_tool.prompt_templates t
        WHERE t.voice_slug = p.slug AND t.category IN ('agent', 'partial')
      ) <> shared_set_count;

    -- personas without exactly one source-policy row
    SELECT count(*) INTO bad_policy
    FROM content_tool.personas p
    WHERE p.is_archived = false
      AND (
        SELECT count(*) FROM content_tool.source_policy s
        WHERE s.voice_slug = p.slug
      ) <> 1;

    RAISE NOTICE 'per_voice_prompt_library: shared agent/partial set = % template(s); non-archived personas = %',
        shared_set_count, persona_count;

    IF bad_templates > 0 THEN
        RAISE EXCEPTION 'per_voice backfill incomplete: % persona(s) missing agent/partial templates', bad_templates;
    END IF;
    IF bad_policy > 0 THEN
        RAISE EXCEPTION 'per_voice backfill incomplete: % persona(s) without exactly one source_policy row', bad_policy;
    END IF;
END
$assert$;
