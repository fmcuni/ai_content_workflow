-- Dedicated low-privilege role for the FastAPI application.
-- Using this role instead of the postgres superuser reduces blast radius if
-- connection credentials leak.  The role is created with NOLOGIN so no password
-- is committed to git; enable login and set the password outside version control:
--   Supabase cloud : Dashboard → Database → Roles, or via supabase db execute
--   Local dev      : psql -c "ALTER ROLE content_tool_app WITH LOGIN PASSWORD '...';"
-- Then update POSTGRES_URL in the env to use content_tool_app (Phase D).

CREATE ROLE content_tool_app
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOLOGIN;

GRANT USAGE ON SCHEMA content_tool TO content_tool_app;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA content_tool
    TO content_tool_app;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA content_tool TO content_tool_app;

-- Ensure future tables/sequences created in the schema inherit the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA content_tool
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO content_tool_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA content_tool
    GRANT USAGE ON SEQUENCES TO content_tool_app;

-- RLS permissive policies for content_tool_app.
-- content_tool_app is not a superuser, so it needs explicit policies to pass RLS
-- checks enabled in rls_hardening.sql.
CREATE POLICY app_allow_all ON content_tool.runs                 TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.gap_analyses         TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.fetched_articles     TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.outlines             TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.drafts               TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.hitl2_snapshots      TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.citations            TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.url_resolution_cache TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.renders              TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.audit_runs           TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.compliance_log       TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.articles             TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.refresh_evaluations  TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.wp_users             TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.wp_categories        TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.prompt_versions      TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.personas             TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.topic_batches        TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.topic_candidates     TO content_tool_app USING (true) WITH CHECK (true);
