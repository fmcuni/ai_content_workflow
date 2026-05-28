-- Enable Row Level Security on all content_tool tables.
-- Defense-in-depth: prevents anon / authenticated Supabase roles from accessing
-- data if the schema is ever accidentally exposed via PostgREST or the Data API.
-- postgres is a superuser and already bypasses RLS; the policy below is belt-and-
-- braces for the transition period while the app still connects as postgres.
-- Permissive policies for content_tool_app are added in dedicated_app_role.

ALTER TABLE content_tool.runs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.gap_analyses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.fetched_articles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.outlines             ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.drafts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.hitl2_snapshots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.citations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.url_resolution_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.renders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.audit_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.compliance_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.articles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.refresh_evaluations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.wp_users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.wp_categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.prompt_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.personas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.topic_batches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.topic_candidates     ENABLE ROW LEVEL SECURITY;

-- Single permissive policy for postgres (current app connection user).
CREATE POLICY postgres_allow_all ON content_tool.runs                 TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.gap_analyses         TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.fetched_articles     TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.outlines             TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.drafts               TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.hitl2_snapshots      TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.citations            TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.url_resolution_cache TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.renders              TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.audit_runs           TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.compliance_log       TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.articles             TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.refresh_evaluations  TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.wp_users             TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.wp_categories        TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.prompt_versions      TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.personas             TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.topic_batches        TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.topic_candidates     TO postgres USING (true) WITH CHECK (true);
