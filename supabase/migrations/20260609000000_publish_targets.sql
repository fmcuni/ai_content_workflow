-- Per-Voice CMS Publish Targets (Phase 1: WordPress-only).
-- Spec: docs/superpowers/specs/2026-06-09-per-voice-cms-publish-targets.md
--
-- Lets each voice (persona) publish to its own CMS instance. Phase 1 ships
-- multiple WordPress targets; Ghost lands later behind the same row `kind`.
--
-- A `publish_targets` row holds NON-SECRET config only: a display `name`, the
-- `kind` discriminator, and an `auth_ref` env-var PREFIX. The actual base URL +
-- credentials live in the environment (.env.local / `wrangler secret`) under
--   {auth_ref}_BASE_URL, {auth_ref}_USERNAME, {auth_ref}_APP_PASSWORD
-- and are resolved at publish time. No URL or credential is ever stored here.
--
-- Safe-to-push-first: personas.publish_target_id is nullable with no default,
-- and a NULL FK resolves to the legacy WP_* env (auth_ref 'WP' = the same
-- vars), so the currently deployed app — which does not yet read the column —
-- is unaffected during the deploy window (CLAUDE.md ordering invariant).
--
-- RLS + grants mirror run_event_logs.sql / source_policy.sql: OWNER postgres,
-- RLS enabled, explicit allow-all policies for postgres + content_tool_app.
-- Table-level GRANTs are inherited via the schema's ALTER DEFAULT PRIVILEGES
-- (20260528143908_dedicated_app_role.sql).

-- ---------------------------------------------------------------------------
-- 1. publish_targets — the CMS target registry (non-secret config only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_tool.publish_targets (
    publish_target_id "uuid" DEFAULT gen_random_uuid() NOT NULL,
    name              character varying NOT NULL,
    kind              character varying NOT NULL,
    auth_ref          character varying NOT NULL,
    status            character varying DEFAULT 'active'::character varying NOT NULL,
    is_archived       boolean DEFAULT false NOT NULL,
    created_at        timestamp with time zone DEFAULT now() NOT NULL,
    updated_at        timestamp with time zone DEFAULT now() NOT NULL,
    created_by        character varying,
    updated_by        character varying,
    -- Phase 1 supports WordPress only; widen this CHECK when Ghost ships.
    CONSTRAINT publish_targets_kind_check CHECK (kind IN ('wordpress')),
    CONSTRAINT publish_targets_status_check CHECK (status IN ('active', 'inactive'))
);

ALTER TABLE content_tool.publish_targets OWNER TO postgres;

ALTER TABLE ONLY content_tool.publish_targets
    ADD CONSTRAINT publish_targets_pkey PRIMARY KEY (publish_target_id);

CREATE INDEX IF NOT EXISTS publish_targets_kind_idx
    ON content_tool.publish_targets USING btree (kind);

ALTER TABLE content_tool.publish_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY postgres_allow_all ON content_tool.publish_targets TO postgres         USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all      ON content_tool.publish_targets TO content_tool_app USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. personas.publish_target_id — nullable FK (NULL → legacy WP_* env)
-- ---------------------------------------------------------------------------
ALTER TABLE content_tool.personas
    ADD COLUMN IF NOT EXISTS publish_target_id "uuid";

ALTER TABLE ONLY content_tool.personas
    ADD CONSTRAINT personas_publish_target_id_fkey
        FOREIGN KEY (publish_target_id)
        REFERENCES content_tool.publish_targets (publish_target_id)
        ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3. Seed the two known WordPress targets with stable UUIDs.
--    auth_ref 'WP'         → existing WP_BASE_URL / WP_USERNAME / WP_APP_PASSWORD
--    auth_ref 'VHIS101_WP' → VHIS101_WP_BASE_URL / _USERNAME / _APP_PASSWORD
-- ---------------------------------------------------------------------------
INSERT INTO content_tool.publish_targets
    (publish_target_id, name, kind, auth_ref, created_by)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'Bowtie WordPress',  'wordpress', 'WP',        'migration:publish_targets'),
    ('00000000-0000-0000-0000-000000000002', 'VHIS101 WordPress', 'wordpress', 'VHIS101_WP','migration:publish_targets')
ON CONFLICT (publish_target_id) DO NOTHING;

-- Point the default Bowtie voice at the Bowtie WordPress target. On a fresh
-- `supabase db reset` the personas table is still empty here (seed.sql runs
-- after migrations), so this matches 0 rows — harmless: the voice's NULL FK
-- then resolves to the identical legacy WP_* env at runtime. On prod `db push`
-- the bowtie-editor row already exists, so it gets the explicit assignment.
UPDATE content_tool.personas
SET publish_target_id = '00000000-0000-0000-0000-000000000001'
WHERE slug = 'bowtie-editor'
  AND publish_target_id IS NULL;
