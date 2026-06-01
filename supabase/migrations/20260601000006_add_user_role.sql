-- Role-based access control: add a `role` column to the better-auth user table.
--
-- Four cumulative roles gate the app's capabilities (see the multi-user
-- resilience & roles design doc):
--   viewer   — read-only
--   author   — create runs, edit drafts/outlines, regenerate
--   reviewer — author + approve HITL_1/HITL_2 + publish to WordPress
--   admin    — reviewer + edit prompts/personas/source-policy, delete,
--              manage user roles, and break-glass override of the 4-eyes rule
--
-- New sign-ups default to `viewer` (least privilege); an admin promotes them.
-- Bootstrap admins are granted at runtime from the BOOTSTRAP_ADMIN_EMAILS env
-- var (the Worker's authz layer treats those emails as admin regardless of the
-- stored role), so no operator identity is hard-coded here and the system is
-- never locked out of role management on a fresh database.
--
-- `role` is a single word, so it keeps better-auth's untouched lowercase casing
-- (unlike the camelCase multi-word columns). content_tool_app already holds the
-- table-level UPDATE grant, which covers the new column.

ALTER TABLE content_tool."user"
    ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'viewer';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_role_check'
    ) THEN
        ALTER TABLE content_tool."user"
            ADD CONSTRAINT user_role_check
            CHECK (role IN ('viewer', 'author', 'reviewer', 'admin'));
    END IF;
END $$;
