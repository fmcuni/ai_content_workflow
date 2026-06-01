-- better-auth core tables for the Cloudflare production deployment.
-- Email/password auth with email verification; sign-up domain-gated to
-- @bowtie.com.hk (enforced in the Worker, see deploy/cloudflare-workers/src/auth).
--
-- Column names are snake_case to match the Worker's better-auth config
-- (`casing: "snake"`) and repo convention. `user` is a reserved word, so it is
-- double-quoted everywhere. RLS + content_tool_app policies mirror
-- dedicated_app_role.sql (defense in depth; the app connects as content_tool_app).

CREATE TABLE IF NOT EXISTS content_tool."user" (
    id             text NOT NULL,
    name           text NOT NULL,
    email          text NOT NULL,
    email_verified boolean NOT NULL DEFAULT false,
    image          text,
    created_at     timestamp with time zone NOT NULL DEFAULT now(),
    updated_at     timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT user_pkey PRIMARY KEY (id),
    CONSTRAINT user_email_key UNIQUE (email)
);
ALTER TABLE content_tool."user" OWNER TO postgres;

CREATE TABLE IF NOT EXISTS content_tool.session (
    id         text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token      text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    ip_address text,
    user_agent text,
    user_id    text NOT NULL,
    CONSTRAINT session_pkey PRIMARY KEY (id),
    CONSTRAINT session_token_key UNIQUE (token),
    CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES content_tool."user" (id) ON DELETE CASCADE
);
ALTER TABLE content_tool.session OWNER TO postgres;
CREATE INDEX IF NOT EXISTS session_user_id_idx ON content_tool.session USING btree (user_id);

CREATE TABLE IF NOT EXISTS content_tool.account (
    id                       text NOT NULL,
    account_id               text NOT NULL,
    provider_id              text NOT NULL,
    user_id                  text NOT NULL,
    access_token             text,
    refresh_token            text,
    id_token                 text,
    access_token_expires_at  timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope                    text,
    password                 text,
    created_at               timestamp with time zone NOT NULL DEFAULT now(),
    updated_at               timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT account_pkey PRIMARY KEY (id),
    CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES content_tool."user" (id) ON DELETE CASCADE
);
ALTER TABLE content_tool.account OWNER TO postgres;
CREATE INDEX IF NOT EXISTS account_user_id_idx ON content_tool.account USING btree (user_id);

CREATE TABLE IF NOT EXISTS content_tool.verification (
    id         text NOT NULL,
    identifier text NOT NULL,
    value      text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT verification_pkey PRIMARY KEY (id)
);
ALTER TABLE content_tool.verification OWNER TO postgres;
CREATE INDEX IF NOT EXISTS verification_identifier_idx
    ON content_tool.verification USING btree (identifier);

-- Row Level Security — belt-and-braces, consistent with rls_hardening.sql.
ALTER TABLE content_tool."user"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.session       ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.account       ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.verification  ENABLE ROW LEVEL SECURITY;

-- postgres superuser bypasses RLS; explicit policy kept for parity with siblings.
CREATE POLICY postgres_allow_all ON content_tool."user"       TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.session      TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.account      TO postgres USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.verification TO postgres USING (true) WITH CHECK (true);

-- content_tool_app (the role the Worker connects as) needs explicit policies.
CREATE POLICY app_allow_all ON content_tool."user"       TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.session      TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.account      TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all ON content_tool.verification TO content_tool_app USING (true) WITH CHECK (true);

-- DML grants. dedicated_app_role.sql set ALTER DEFAULT PRIVILEGES for future
-- tables, but grant explicitly so this migration is self-contained.
GRANT SELECT, INSERT, UPDATE, DELETE ON content_tool."user"       TO content_tool_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON content_tool.session      TO content_tool_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON content_tool.account      TO content_tool_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON content_tool.verification TO content_tool_app;
