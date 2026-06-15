-- Per-voice WordPress taxonomy cache (Phase 1.5).
-- Spec: docs/design/specs/2026-06-08-per-voice-wp-taxonomy-cache.md
--
-- wp_users / wp_categories were single-instance snapshots (the Bowtie WP only).
-- Add an `auth_ref` discriminator (the publish_targets env-prefix, e.g. 'WP' or
-- 'VHIS101_WP') so the HITL_2 author/category pickers can show the entities of
-- the voice's OWN CMS instead of always Bowtie's.
--
-- Backward compatible: existing rows backfill to 'WP' via the column DEFAULT,
-- and a NULL/unassigned voice resolves to 'WP' at read time — byte-identical to
-- today for the Bowtie voice. Safe to push BEFORE code ships: the currently
-- deployed reads carry no auth_ref filter, so they still return the Bowtie rows
-- (now tagged 'WP'). RLS policies + grants are unaffected by the column/PK change.

-- ---------------------------------------------------------------------------
-- 1. auth_ref discriminator (default 'WP' backfills the existing Bowtie rows)
-- ---------------------------------------------------------------------------
ALTER TABLE content_tool.wp_users
    ADD COLUMN IF NOT EXISTS auth_ref character varying NOT NULL DEFAULT 'WP';
ALTER TABLE content_tool.wp_categories
    ADD COLUMN IF NOT EXISTS auth_ref character varying NOT NULL DEFAULT 'WP';

-- ---------------------------------------------------------------------------
-- 2. WordPress supplies the ids; the sync inserts them verbatim. Drop the
--    autoincrement default so the same id can recur under a different auth_ref.
-- ---------------------------------------------------------------------------
ALTER TABLE content_tool.wp_users      ALTER COLUMN id DROP DEFAULT;
ALTER TABLE content_tool.wp_categories ALTER COLUMN id DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- 3. Re-key on (auth_ref, id): the same WP id can exist on multiple instances.
-- ---------------------------------------------------------------------------
ALTER TABLE content_tool.wp_users      DROP CONSTRAINT IF EXISTS wp_users_pkey;
ALTER TABLE content_tool.wp_categories DROP CONSTRAINT IF EXISTS wp_categories_pkey;

ALTER TABLE ONLY content_tool.wp_users
    ADD CONSTRAINT wp_users_pkey PRIMARY KEY (auth_ref, id);
ALTER TABLE ONLY content_tool.wp_categories
    ADD CONSTRAINT wp_categories_pkey PRIMARY KEY (auth_ref, id);
