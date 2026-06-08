-- Version-history baselines + optional change note.
--
-- Background: prompt_versions / source_policy_versions are append-only history,
-- written only on save/revert. The seed-of-record templates (and any voice rows
-- predating the per-voice history seeding in personas.duplicate_persona) have a
-- LIVE row in prompt_templates / source_policy but NO history row, so the
-- editor's History panel is empty and the pristine seeded body is unrecoverable.
--
-- This migration:
--   1. Adds a nullable `note` column to both *_versions tables (optional
--      human-supplied change reason; wired through the API/UI separately).
--   2. Backfills one kind='seed' baseline row per live template/policy that has
--      no version row yet, byte-identical to the live body.
--
-- Idempotent: the `note` adds use IF NOT EXISTS; the backfills use NOT EXISTS
-- guards, so re-running (or `supabase db reset`) is safe. Additive + history-
-- only => behaviour-neutral for the runtime (loaders still read the live
-- prompt_templates / source_policy rows). Parity-safe across both backends.

ALTER TABLE content_tool.prompt_versions
    ADD COLUMN IF NOT EXISTS note character varying;

ALTER TABLE content_tool.source_policy_versions
    ADD COLUMN IF NOT EXISTS note character varying;

-- Baseline (kind='seed') for every live prompt template lacking any history.
-- saved_at = the template's updated_at so the seed sorts as v1 (oldest).
INSERT INTO content_tool.prompt_versions
    (version_id, voice_slug, template_id, sha256, parent_sha256, body, bytes,
     saved_by, saved_at, kind)
SELECT
    gen_random_uuid(), t.voice_slug, t.template_id, t.sha256, NULL, t.body,
    t.bytes, 'system:seed', COALESCE(t.updated_at, now()), 'seed'
FROM content_tool.prompt_templates t
WHERE NOT EXISTS (
    SELECT 1 FROM content_tool.prompt_versions v
    WHERE v.voice_slug = t.voice_slug
      AND v.template_id = t.template_id
);

-- Baseline (kind='seed') for every live source policy lacking any history.
INSERT INTO content_tool.source_policy_versions
    (version_id, voice_slug, policy_id, sha256, parent_sha256, body, bytes,
     saved_by, saved_at, kind)
SELECT
    gen_random_uuid(), p.voice_slug, 'default', p.sha256, NULL, p.body,
    p.bytes, 'system:seed', COALESCE(p.updated_at, now()), 'seed'
FROM content_tool.source_policy p
WHERE NOT EXISTS (
    SELECT 1 FROM content_tool.source_policy_versions v
    WHERE v.voice_slug = p.voice_slug
);
