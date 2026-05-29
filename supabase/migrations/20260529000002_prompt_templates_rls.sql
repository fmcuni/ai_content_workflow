-- Row Level Security for content_tool.prompt_templates.
-- Mirrors rls_hardening.sql + dedicated_app_role.sql for the live prompt-template
-- store added in 20260529000001_prompt_templates.sql.  Defense-in-depth: keeps the
-- table inaccessible to anon / authenticated Supabase roles if the schema is ever
-- exposed, while granting full access to postgres (current app user) and the
-- dedicated content_tool_app role (Phase D target).

ALTER TABLE content_tool.prompt_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY postgres_allow_all ON content_tool.prompt_templates TO postgres USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all      ON content_tool.prompt_templates TO content_tool_app USING (true) WITH CHECK (true);
