-- Seed the HKVHIS WordPress publish target (non-secret config only).
--
-- Mirrors the WordPress target seeding in 20260609000000_publish_targets.sql:
-- a row holds only `name`, `kind`, and the `auth_ref` env-var PREFIX. For this
-- WordPress target, auth_ref 'HKVHIS_WP' resolves at publish time (in the
-- Worker) to
--   HKVHIS_WP_BASE_URL / HKVHIS_WP_USERNAME / HKVHIS_WP_APP_PASSWORD
-- which already live as `wrangler secret`s on the backend Worker (shared
-- dev<->prod WordPress) — never stored here.
--
-- Idempotent: only inserts when no HKVHIS_WP target exists yet, so it is a
-- no-op on environments (e.g. dev) that already have one, and re-runnable.
-- Intentionally does NOT attach any persona — a voice's publish_target_id is
-- pointed at this row separately (UI or a follow-up UPDATE).
INSERT INTO content_tool.publish_targets
    (publish_target_id, name, kind, auth_ref, created_by)
SELECT
    '00000000-0000-0000-0000-000000000004',
    'HKVHIS WordPress',
    'wordpress',
    'HKVHIS_WP',
    'migration:seed_hkvhis_publish_target'
WHERE NOT EXISTS (
    SELECT 1 FROM content_tool.publish_targets
    WHERE kind = 'wordpress' AND auth_ref = 'HKVHIS_WP'
);
