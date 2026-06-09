-- content_tool.app_user — the app's view of an authenticated user.
-- Spec: docs/superpowers/specs/2026-06-10-supabase-auth-migration.md (WS0)
--
-- Identity itself lives in Supabase's `auth` schema (GoTrue). This table holds
-- only the app-owned facets: role (4-role cumulative model), display name,
-- active/disabled status, and a mirror of last-sign-in. `id` is the Supabase
-- auth uuid as a SOFT reference — no hard cross-schema FK to `auth.users`, so a
-- GoTrue user can exist before its app_user row (admin-create flow) and the two
-- schemas stay independently migratable.
--
-- Deploy ordering invariant (CLAUDE.md): this migration must land BEFORE any
-- code reads/writes the table. WS0 ships the migration only; the Worker still
-- reads content_tool."user" until WS1 retargets `loadRole` behind AUTH_PROVIDER.
--
-- RLS + grants mirror better_auth.sql / publish_targets.sql: OWNER postgres,
-- RLS enabled (defense in depth), explicit allow-all policies for postgres +
-- content_tool_app, plus explicit table GRANTs to content_tool_app.

-- ---------------------------------------------------------------------------
-- 1. app_user
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_tool.app_user (
    id              text PRIMARY KEY,                    -- Supabase auth uuid (soft ref)
    email           text NOT NULL UNIQUE,
    display_name    text,
    role            text NOT NULL DEFAULT 'viewer',
    status          text NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_sign_in_at timestamptz,
    CONSTRAINT app_user_role_check
        CHECK (role IN ('viewer', 'author', 'reviewer', 'admin')),
    CONSTRAINT app_user_status_check
        CHECK (status IN ('active', 'disabled'))
);

ALTER TABLE content_tool.app_user OWNER TO postgres;

-- Email lookup path (loadRole falls back to email when no id match).
CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_idx
    ON content_tool.app_user USING btree (lower(email));

-- ---------------------------------------------------------------------------
-- 2. RLS — enabled as defense in depth; allow-all for the trusted roles.
-- ---------------------------------------------------------------------------
ALTER TABLE content_tool.app_user ENABLE ROW LEVEL SECURITY;

CREATE POLICY postgres_allow_all ON content_tool.app_user
    TO postgres         USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all      ON content_tool.app_user
    TO content_tool_app USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. Grants (explicit, mirroring better_auth.sql; also covered by the schema's
--    ALTER DEFAULT PRIVILEGES from 20260528143908_dedicated_app_role.sql).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON content_tool.app_user TO content_tool_app;
