-- Default search_path for the application connection role.
--
-- better-auth (on the Cloudflare Worker) issues UNQUALIFIED table names
-- (`user`, `session`, ...) which live in the `content_tool` schema. The Worker
-- connects through Hyperdrive, which does NOT support per-connection startup
-- parameters (e.g. postgres.js `connection: { search_path }`) — it hangs on
-- them. So we set the search_path as a DB-scoped default on the connecting role
-- instead. Hyperdrive connects as `postgres` (the Supabase pooler user
-- postgres.<ref> maps to the postgres role).
--
-- This is safe for the rest of the codebase: every existing query fully
-- qualifies tables with `content_tool.` and is therefore unaffected. `public`
-- and `extensions` remain on the path for Supabase internals / extension funcs.
ALTER ROLE postgres IN DATABASE postgres
    SET search_path TO content_tool, public, extensions;
