-- LLM-judge eval results store (content_tool.evals).
-- Ports the SQLAlchemy Eval model (content_tool/db/models.py) that was missed in
-- the Alembic -> Supabase migration. Mirrors the table-creation, ownership, RLS,
-- and grant conventions used by the baseline + prompt_templates migrations.
-- Defense-in-depth: RLS enabled so the table stays inaccessible to anon /
-- authenticated Supabase roles if the schema is ever exposed, while granting full
-- access to postgres (current app user) and the dedicated content_tool_app role.

CREATE TABLE IF NOT EXISTS "content_tool"."evals" (
    "eval_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metric" character varying NOT NULL,
    "fixture_id" character varying NOT NULL,
    "run_id" "uuid",
    "score" double precision,
    "pass" boolean DEFAULT false NOT NULL,
    "judge_notes" "jsonb",
    "commit_sha" character varying NOT NULL
);

ALTER TABLE "content_tool"."evals" OWNER TO "postgres";

ALTER TABLE ONLY "content_tool"."evals"
    ADD CONSTRAINT "evals_pkey" PRIMARY KEY ("eval_id");

-- Row Level Security (defense-in-depth), mirroring prompt_templates_rls.sql.
ALTER TABLE "content_tool"."evals" ENABLE ROW LEVEL SECURITY;

CREATE POLICY postgres_allow_all ON "content_tool"."evals" TO postgres USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all      ON "content_tool"."evals" TO content_tool_app USING (true) WITH CHECK (true);

-- Explicit grants for the dedicated app role. The schema-level ALTER DEFAULT
-- PRIVILEGES in dedicated_app_role.sql only covers tables created by postgres
-- after that migration ran, so grant explicitly to be safe.
GRANT SELECT, INSERT, UPDATE, DELETE ON "content_tool"."evals" TO content_tool_app;
