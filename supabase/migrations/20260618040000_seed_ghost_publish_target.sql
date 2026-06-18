-- Seed the HealthyCheck HK Ghost (Pro) publish target (non-secret config only).
--
-- Mirrors the WordPress target seeding in 20260609000000_publish_targets.sql:
-- a row holds only `name`, `kind`, and the `auth_ref` env-var PREFIX. For a
-- Ghost target, auth_ref 'HCHK_GT' resolves at publish time (in the Worker) to
--   HCHK_GT_API_URL        (Ghost Admin API base URL)
--   HCHK_GT_ADMIN_API_KEY  (Ghost Admin key, id:secret)
-- which live as `wrangler secret`s on the backend Worker — never stored here.
--
-- Idempotent: only inserts when no Ghost/HCHK_GT target exists yet, so it is a
-- no-op on environments (e.g. dev) that already have one, and re-runnable.
-- Intentionally does NOT attach any persona — a voice's publish_target_id is
-- pointed at this row only after the HCHK_GT_* secrets are set, to avoid a
-- voice attempting a Ghost publish before credentials exist.
INSERT INTO content_tool.publish_targets
    (publish_target_id, name, kind, auth_ref, created_by)
SELECT
    '00000000-0000-0000-0000-000000000003',
    'HealthyCheck HK (Ghost)',
    'ghost',
    'HCHK_GT',
    'migration:seed_ghost_publish_target'
WHERE NOT EXISTS (
    SELECT 1 FROM content_tool.publish_targets
    WHERE kind = 'ghost' AND auth_ref = 'HCHK_GT'
);
