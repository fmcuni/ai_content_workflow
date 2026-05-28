


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "content_tool";


ALTER SCHEMA "content_tool" OWNER TO "postgres";


CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";





SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "content_tool"."articles" (
    "article_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "article_url" "text" NOT NULL,
    "wp_post_id" integer,
    "topic" "text",
    "persona" "text",
    "topic_category" "text",
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_persisted_at" timestamp with time zone,
    "next_scan_due_at" timestamp with time zone NOT NULL,
    "dismissed_until" timestamp with time zone,
    "dismissed_by" "text",
    "dismissed_reason" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "content_tool"."articles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."audit_runs" (
    "audit_id" "uuid" NOT NULL,
    "draft_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "overall_pass" boolean NOT NULL,
    "severity_high" integer DEFAULT 0 NOT NULL,
    "severity_medium" integer DEFAULT 0 NOT NULL,
    "severity_low" integer DEFAULT 0 NOT NULL,
    "llm_findings" "jsonb" NOT NULL,
    "deterministic_findings" "jsonb" NOT NULL,
    "tokens_in" integer,
    "tokens_out" integer,
    "latency_ms" integer
);


ALTER TABLE "content_tool"."audit_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."citations" (
    "citation_id" "uuid" NOT NULL,
    "draft_id" "uuid" NOT NULL,
    "chunk_idx" integer,
    "vertex_uri" character varying NOT NULL,
    "final_url" character varying,
    "domain" character varying,
    "title" character varying,
    "policy_decision" character varying NOT NULL,
    "denied_reason" character varying,
    "was_displayed" boolean DEFAULT false NOT NULL,
    "resolution_error" character varying,
    "resolved_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "content_tool"."citations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."compliance_log" (
    "log_id" "uuid" NOT NULL,
    "run_id" "uuid" NOT NULL,
    "persisted_at" timestamp with time zone DEFAULT "now"(),
    "persona" character varying NOT NULL,
    "article_url" character varying NOT NULL,
    "wp_pushed_post_id" integer,
    "chosen_route" character varying NOT NULL,
    "sources_cited" character varying NOT NULL,
    "sources_denied" character varying,
    "audit_overall_pass" boolean NOT NULL,
    "audit_severity_summary" "jsonb" NOT NULL,
    "approver_email" character varying NOT NULL,
    "iteration_count" integer NOT NULL,
    "gemini_model" character varying NOT NULL,
    "total_tokens" integer,
    "est_cost_usd_cents" integer
);


ALTER TABLE "content_tool"."compliance_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."drafts" (
    "draft_id" "uuid" NOT NULL,
    "run_id" "uuid" NOT NULL,
    "iteration" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "diagnose" character varying NOT NULL,
    "markup_raw" character varying NOT NULL,
    "final_markup" character varying,
    "citation_intents" "jsonb" NOT NULL,
    "grounding_chunks" "jsonb",
    "tokens_in" integer,
    "tokens_out" integer,
    "thinking_tokens" integer,
    "latency_ms" integer
);


ALTER TABLE "content_tool"."drafts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."fetched_articles" (
    "run_id" "uuid" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "wp_post_id" integer,
    "wp_categories" "jsonb",
    "raw_html" character varying,
    "markdown" character varying NOT NULL,
    "wp_author_id" integer,
    "wp_slug" "text",
    "wp_link" "text"
);


ALTER TABLE "content_tool"."fetched_articles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."gap_analyses" (
    "run_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "model" character varying NOT NULL,
    "thinking_level" character varying NOT NULL,
    "payload" "jsonb" NOT NULL,
    "tokens_in" integer,
    "tokens_out" integer,
    "thinking_tokens" integer,
    "latency_ms" integer,
    "raw_response" "jsonb"
);


ALTER TABLE "content_tool"."gap_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."hitl2_snapshots" (
    "snapshot_id" "uuid" NOT NULL,
    "run_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" character varying,
    "trigger" character varying NOT NULL,
    "html_body" character varying NOT NULL,
    "seo_title" character varying,
    "meta_description" character varying,
    "notes" character varying,
    "comments" "jsonb",
    "wp_publish_status" character varying,
    "wp_author_id" integer,
    "wp_category_ids" "jsonb",
    "wp_tag_ids" "jsonb",
    "wp_featured_media_id" integer,
    "wp_slug" character varying,
    "wp_excerpt" character varying,
    "wp_publish_at" timestamp with time zone
);


ALTER TABLE "content_tool"."hitl2_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."outlines" (
    "run_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "payload" "jsonb" NOT NULL,
    "edited_by_human" boolean DEFAULT false NOT NULL,
    "human_edits" "jsonb"
);


ALTER TABLE "content_tool"."outlines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."personas" (
    "persona_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" character varying NOT NULL,
    "name" character varying NOT NULL,
    "voice_rules" "jsonb" NOT NULL,
    "banned_terms" "jsonb" NOT NULL,
    "required_phrasings" "jsonb" NOT NULL,
    "disclaimer_templates" "jsonb" NOT NULL,
    "tone_examples" "jsonb" NOT NULL,
    "is_archived" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" character varying,
    "updated_by" character varying,
    "glossary" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL
);


ALTER TABLE "content_tool"."personas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."prompt_versions" (
    "version_id" "uuid" NOT NULL,
    "template_id" character varying NOT NULL,
    "sha256" character varying NOT NULL,
    "parent_sha256" character varying,
    "body" character varying NOT NULL,
    "bytes" integer NOT NULL,
    "saved_by" character varying NOT NULL,
    "saved_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" character varying DEFAULT 'save'::character varying NOT NULL
);


ALTER TABLE "content_tool"."prompt_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."refresh_evaluations" (
    "evaluation_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "article_id" "uuid" NOT NULL,
    "evaluated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "scanner_version" "text" NOT NULL,
    "trigger_source" "text" NOT NULL,
    "age_days" integer NOT NULL,
    "fetched_html_hash" "text",
    "deterministic_findings" "jsonb" NOT NULL,
    "llm_findings" "jsonb",
    "llm_skipped_reason" "text",
    "staleness_score" numeric(4,2) NOT NULL,
    "recommended_action" "text" NOT NULL,
    "outcome" "text" DEFAULT 'open'::"text" NOT NULL,
    "resulting_run_id" "uuid",
    "outcome_set_at" timestamp with time zone,
    "outcome_set_by" "text",
    "tokens_in" integer,
    "tokens_out" integer,
    "est_cost_usd_cents" integer,
    "latency_ms" integer
);


ALTER TABLE "content_tool"."refresh_evaluations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."renders" (
    "render_id" "uuid" NOT NULL,
    "draft_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "seo_title" character varying NOT NULL,
    "meta_description" character varying NOT NULL,
    "html_body" character varying NOT NULL,
    "faq_schema_jsonld" "jsonb",
    "excerpt_suggestion" character varying,
    "slug_suggestion" character varying
);


ALTER TABLE "content_tool"."renders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."runs" (
    "run_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" character varying NOT NULL,
    "status" character varying NOT NULL,
    "article_url" character varying,
    "topic" character varying NOT NULL,
    "keywords" "jsonb" NOT NULL,
    "mode" character varying NOT NULL,
    "edit_note" character varying,
    "acf_adv_id" integer NOT NULL,
    "acf_widget_id" integer NOT NULL,
    "persona" character varying NOT NULL,
    "topic_category" character varying,
    "today_date" "date" NOT NULL,
    "chosen_route" character varying,
    "iteration_count" integer DEFAULT 0 NOT NULL,
    "hitl_1_decision" character varying,
    "hitl_1_notes" character varying,
    "hitl_2_decision" character varying,
    "hitl_2_notes" character varying,
    "approved_at" timestamp with time zone,
    "approved_by" character varying,
    "wp_author_id" integer,
    "wp_category_ids" "jsonb",
    "wp_tag_ids" "jsonb",
    "wp_featured_media_id" integer,
    "wp_slug" character varying,
    "wp_excerpt" character varying,
    "wp_publish_status" character varying,
    "wp_publish_at" timestamp with time zone,
    "wp_pushed_post_id" integer,
    "wp_pushed_at" timestamp with time zone,
    "wp_push_error" "jsonb",
    "error" "jsonb",
    "article_id" "uuid",
    "triggered_by_evaluation_id" "uuid",
    "hitl_2_comments" "jsonb",
    "hitl_2_iteration" integer DEFAULT 0 NOT NULL,
    "start_mode" "text" DEFAULT 'refresh'::"text" NOT NULL,
    "topic_candidate_id" "uuid",
    "target_audience" "text"
);


ALTER TABLE "content_tool"."runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."topic_batches" (
    "batch_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text" NOT NULL,
    "status" "text" NOT NULL,
    "research_theme" "text" NOT NULL,
    "target_audience" "text" NOT NULL,
    "topic_count" integer NOT NULL,
    "keywords_per_topic" integer NOT NULL,
    "must_cover" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "must_avoid" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "priority_focus" "text",
    "notes" "text",
    "persona_default" "text",
    "acf_adv_id_default" integer,
    "acf_widget_id_default" integer,
    "cost_cents" integer DEFAULT 0 NOT NULL,
    "last_error" "text"
);


ALTER TABLE "content_tool"."topic_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."topic_candidates" (
    "candidate_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "position" integer NOT NULL,
    "status" "text" DEFAULT 'candidate'::"text" NOT NULL,
    "topic" "text" NOT NULL,
    "keywords" "jsonb" NOT NULL,
    "original_topic" "text" NOT NULL,
    "original_keywords" "jsonb" NOT NULL,
    "existing" "text",
    "existing_note" "text",
    "existing_url" "text",
    "hot_topic" "text",
    "hot_topic_note" "text",
    "persona_slug" "text",
    "acf_adv_id" integer,
    "acf_widget_id" integer,
    "operator_note" "text",
    "promote_mode" "text",
    "promoted_run_id" "uuid",
    "last_error" "text",
    "last_edited_by" "text",
    "last_edited_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "content_tool"."topic_candidates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."url_resolution_cache" (
    "vertex_uri" character varying NOT NULL,
    "final_url" character varying,
    "domain" character varying,
    "resolved_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone NOT NULL,
    "error" character varying
);


ALTER TABLE "content_tool"."url_resolution_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content_tool"."wp_categories" (
    "id" integer NOT NULL,
    "name" character varying NOT NULL,
    "slug" character varying NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "content_tool"."wp_categories" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "content_tool"."wp_categories_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "content_tool"."wp_categories_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "content_tool"."wp_categories_id_seq" OWNED BY "content_tool"."wp_categories"."id";



CREATE TABLE IF NOT EXISTS "content_tool"."wp_users" (
    "id" integer NOT NULL,
    "name" character varying NOT NULL,
    "slug" character varying NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "content_tool"."wp_users" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "content_tool"."wp_users_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "content_tool"."wp_users_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "content_tool"."wp_users_id_seq" OWNED BY "content_tool"."wp_users"."id";



ALTER TABLE ONLY "content_tool"."wp_categories" ALTER COLUMN "id" SET DEFAULT "nextval"('"content_tool"."wp_categories_id_seq"'::"regclass");



ALTER TABLE ONLY "content_tool"."wp_users" ALTER COLUMN "id" SET DEFAULT "nextval"('"content_tool"."wp_users_id_seq"'::"regclass");



ALTER TABLE ONLY "content_tool"."articles"
    ADD CONSTRAINT "articles_pkey" PRIMARY KEY ("article_id");



ALTER TABLE ONLY "content_tool"."audit_runs"
    ADD CONSTRAINT "audit_runs_draft_id_key" UNIQUE ("draft_id");



ALTER TABLE ONLY "content_tool"."audit_runs"
    ADD CONSTRAINT "audit_runs_pkey" PRIMARY KEY ("audit_id");



ALTER TABLE ONLY "content_tool"."citations"
    ADD CONSTRAINT "citations_pkey" PRIMARY KEY ("citation_id");



ALTER TABLE ONLY "content_tool"."compliance_log"
    ADD CONSTRAINT "compliance_log_pkey" PRIMARY KEY ("log_id");



ALTER TABLE ONLY "content_tool"."compliance_log"
    ADD CONSTRAINT "compliance_log_run_id_key" UNIQUE ("run_id");



ALTER TABLE ONLY "content_tool"."drafts"
    ADD CONSTRAINT "drafts_pkey" PRIMARY KEY ("draft_id");



ALTER TABLE ONLY "content_tool"."drafts"
    ADD CONSTRAINT "drafts_run_id_iteration_key" UNIQUE ("run_id", "iteration");



ALTER TABLE ONLY "content_tool"."fetched_articles"
    ADD CONSTRAINT "fetched_articles_pkey" PRIMARY KEY ("run_id");



ALTER TABLE ONLY "content_tool"."gap_analyses"
    ADD CONSTRAINT "gap_analyses_pkey" PRIMARY KEY ("run_id");



ALTER TABLE ONLY "content_tool"."hitl2_snapshots"
    ADD CONSTRAINT "hitl2_snapshots_pkey" PRIMARY KEY ("snapshot_id");



ALTER TABLE ONLY "content_tool"."outlines"
    ADD CONSTRAINT "outlines_pkey" PRIMARY KEY ("run_id");



ALTER TABLE ONLY "content_tool"."personas"
    ADD CONSTRAINT "personas_pkey" PRIMARY KEY ("persona_id");



ALTER TABLE ONLY "content_tool"."personas"
    ADD CONSTRAINT "personas_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "content_tool"."prompt_versions"
    ADD CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("version_id");



ALTER TABLE ONLY "content_tool"."refresh_evaluations"
    ADD CONSTRAINT "refresh_evaluations_pkey" PRIMARY KEY ("evaluation_id");



ALTER TABLE ONLY "content_tool"."renders"
    ADD CONSTRAINT "renders_pkey" PRIMARY KEY ("render_id");



ALTER TABLE ONLY "content_tool"."runs"
    ADD CONSTRAINT "runs_pkey" PRIMARY KEY ("run_id");



ALTER TABLE ONLY "content_tool"."topic_batches"
    ADD CONSTRAINT "topic_batches_pkey" PRIMARY KEY ("batch_id");



ALTER TABLE ONLY "content_tool"."topic_candidates"
    ADD CONSTRAINT "topic_candidates_pkey" PRIMARY KEY ("candidate_id");



ALTER TABLE ONLY "content_tool"."url_resolution_cache"
    ADD CONSTRAINT "url_resolution_cache_pkey" PRIMARY KEY ("vertex_uri");



ALTER TABLE ONLY "content_tool"."wp_categories"
    ADD CONSTRAINT "wp_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "content_tool"."wp_users"
    ADD CONSTRAINT "wp_users_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "articles_article_url_uidx" ON "content_tool"."articles" USING "btree" ("article_url");



CREATE INDEX "articles_next_scan_due_idx" ON "content_tool"."articles" USING "btree" ("next_scan_due_at") WHERE ("dismissed_until" IS NULL);



CREATE INDEX "articles_wp_post_id_idx" ON "content_tool"."articles" USING "btree" ("wp_post_id") WHERE ("wp_post_id" IS NOT NULL);



CREATE INDEX "citations_draft_id_idx" ON "content_tool"."citations" USING "btree" ("draft_id");



CREATE INDEX "hitl2_snapshots_run_created_idx" ON "content_tool"."hitl2_snapshots" USING "btree" ("run_id", "created_at");



CREATE INDEX "prompt_versions_template_idx" ON "content_tool"."prompt_versions" USING "btree" ("template_id", "saved_at");



CREATE INDEX "refresh_evals_article_evaluated_idx" ON "content_tool"."refresh_evaluations" USING "btree" ("article_id", "evaluated_at" DESC);



CREATE INDEX "refresh_evals_open_idx" ON "content_tool"."refresh_evaluations" USING "btree" ("recommended_action", "outcome") WHERE (("outcome" = 'open'::"text") AND ("recommended_action" = 'refresh'::"text"));



CREATE INDEX "runs_article_id_idx" ON "content_tool"."runs" USING "btree" ("article_id");



CREATE INDEX "runs_created_at_idx" ON "content_tool"."runs" USING "btree" ("created_at" DESC);



CREATE INDEX "runs_status_idx" ON "content_tool"."runs" USING "btree" ("status");



CREATE INDEX "runs_topic_candidate_id_idx" ON "content_tool"."runs" USING "btree" ("topic_candidate_id");



CREATE INDEX "topic_batches_created_at_idx" ON "content_tool"."topic_batches" USING "btree" ("created_at" DESC);



CREATE INDEX "topic_candidates_batch_id_idx" ON "content_tool"."topic_candidates" USING "btree" ("batch_id");



CREATE INDEX "topic_candidates_promoted_run_id_idx" ON "content_tool"."topic_candidates" USING "btree" ("promoted_run_id");



CREATE INDEX "wp_categories_name_idx" ON "content_tool"."wp_categories" USING "btree" ("name");



CREATE INDEX "wp_users_name_idx" ON "content_tool"."wp_users" USING "btree" ("name");



ALTER TABLE ONLY "content_tool"."audit_runs"
    ADD CONSTRAINT "audit_runs_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "content_tool"."drafts"("draft_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."citations"
    ADD CONSTRAINT "citations_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "content_tool"."drafts"("draft_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."compliance_log"
    ADD CONSTRAINT "compliance_log_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "content_tool"."runs"("run_id");



ALTER TABLE ONLY "content_tool"."drafts"
    ADD CONSTRAINT "drafts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "content_tool"."runs"("run_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."fetched_articles"
    ADD CONSTRAINT "fetched_articles_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "content_tool"."runs"("run_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."gap_analyses"
    ADD CONSTRAINT "gap_analyses_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "content_tool"."runs"("run_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."hitl2_snapshots"
    ADD CONSTRAINT "hitl2_snapshots_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "content_tool"."runs"("run_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."outlines"
    ADD CONSTRAINT "outlines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "content_tool"."runs"("run_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."refresh_evaluations"
    ADD CONSTRAINT "refresh_evaluations_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "content_tool"."articles"("article_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."refresh_evaluations"
    ADD CONSTRAINT "refresh_evaluations_resulting_run_id_fkey" FOREIGN KEY ("resulting_run_id") REFERENCES "content_tool"."runs"("run_id");



ALTER TABLE ONLY "content_tool"."renders"
    ADD CONSTRAINT "renders_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "content_tool"."drafts"("draft_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."runs"
    ADD CONSTRAINT "runs_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "content_tool"."articles"("article_id");



ALTER TABLE ONLY "content_tool"."runs"
    ADD CONSTRAINT "runs_topic_candidate_id_fkey" FOREIGN KEY ("topic_candidate_id") REFERENCES "content_tool"."topic_candidates"("candidate_id");



ALTER TABLE ONLY "content_tool"."runs"
    ADD CONSTRAINT "runs_triggered_by_evaluation_id_fkey" FOREIGN KEY ("triggered_by_evaluation_id") REFERENCES "content_tool"."refresh_evaluations"("evaluation_id");



ALTER TABLE ONLY "content_tool"."topic_candidates"
    ADD CONSTRAINT "topic_candidates_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "content_tool"."topic_batches"("batch_id") ON DELETE CASCADE;



ALTER TABLE ONLY "content_tool"."topic_candidates"
    ADD CONSTRAINT "topic_candidates_promoted_run_id_fkey" FOREIGN KEY ("promoted_run_id") REFERENCES "content_tool"."runs"("run_id");





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";























































































































































































ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































