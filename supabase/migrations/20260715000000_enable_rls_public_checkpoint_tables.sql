-- Enable RLS on the LangGraph checkpointer tables that live in the `public`
-- schema. These are created at runtime by the Python backend's Postgres
-- checkpointer (AsyncPostgresSaver.setup()), NOT by a migration — so they land
-- in `public` with Supabase's default grants (anon/authenticated get full DML)
-- and RLS disabled. That is Data-API-reachable; Supabase flags it as
-- `rls_disabled_in_public`.
--
-- The app connects as the `postgres` role, which has BYPASSRLS, so enabling RLS
-- with NO policies denies anon/authenticated (the Data API surface) while the
-- app keeps full access via its direct SQL connection. No policy is needed —
-- nothing except the bypass-RLS owner should ever touch these tables.
--
-- Guarded so it is a no-op where the tables do not exist yet (fresh local
-- `supabase db reset`, and the dev project, which has no checkpoint tables).
-- ponytail: RLS-enable only. Fuller fix (checkpointer creates tables with RLS,
-- or moves them out of `public`) lives in the Python checkpointer setup; do it
-- there if fresh envs re-trip the advisor.
-- Also REVOKE the default anon/authenticated grants (belt-and-suspenders on top
-- of RLS). Role-guarded so it is a no-op off Supabase, where those roles do not
-- exist. Kept byte-for-byte in sync with the checkpointer self-heal in
-- content_tool/graph/checkpointer.py (_HARDEN_CHECKPOINT_TABLES_SQL), which
-- re-applies this on every AsyncPostgresSaver.setup() so freshly-created tables
-- are covered too.
do $$
declare
  t text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
begin
  foreach t in array array['checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'checkpoint_migrations']
  loop
    if exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relkind = 'r'
    ) then
      execute format('alter table public.%I enable row level security', t);
      if has_anon then execute format('revoke all on public.%I from anon', t); end if;
      if has_auth then execute format('revoke all on public.%I from authenticated', t); end if;
    end if;
  end loop;
end $$;
