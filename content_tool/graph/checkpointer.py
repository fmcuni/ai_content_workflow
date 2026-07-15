from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

# AsyncPostgresSaver.setup() creates its tables in the `public` schema at
# runtime. On Supabase, `public` is the Data-API-exposed schema and anon/
# authenticated receive default grants, so the tables land world-readable AND
# world-writable with RLS off (Supabase flags this as `rls_disabled_in_public`).
# Self-heal after every setup(): enable RLS and revoke the anon grants. The app
# connects as a BYPASSRLS role (`postgres`) so it is unaffected. Idempotent and
# role-guarded, so it is a harmless no-op off Supabase (where anon/authenticated
# do not exist). Mirrors migration 20260715000000 for already-created tables.
_HARDEN_CHECKPOINT_TABLES_SQL = """
do $$
declare
  t text;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
begin
  foreach t in array array[
    'checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'checkpoint_migrations'
  ]
  loop
    if exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relkind = 'r'
    ) then
      execute format('alter table public.%I enable row level security', t);
      if has_anon then execute format('revoke all on public.%I from anon', t); end if;
      if has_auth then execute format('revoke all on public.%I from authenticated', t); end if;
    end if;
  end loop;
end $$;
"""


@asynccontextmanager
async def make_checkpointer(postgres_url: str) -> AsyncIterator[AsyncPostgresSaver]:
    # LangGraph's checkpointer uses psycopg async, not SQLAlchemy.
    # postgres_url should be a libpq URL (postgres://...); strip SQLAlchemy's "+asyncpg" if present.
    libpq_url = postgres_url.replace("+asyncpg", "")
    # autocommit=True is required because saver.setup() runs CREATE INDEX CONCURRENTLY,
    # which cannot run inside a transaction block. dict_row + prepare_threshold=0 match
    # AsyncPostgresSaver.from_conn_string defaults.
    pool_kwargs = {"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row}
    async with AsyncConnectionPool(libpq_url, max_size=4, open=False, kwargs=pool_kwargs) as pool:
        await pool.open()
        saver = AsyncPostgresSaver(pool)
        await saver.setup()
        # Lock down the public-schema checkpoint tables setup() just created.
        async with pool.connection() as conn:
            await conn.execute(_HARDEN_CHECKPOINT_TABLES_SQL)
        yield saver
