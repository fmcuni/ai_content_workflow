-- DB-backed, editable source policy (the structured rules rendered into the
-- {source_policy_block} writer placeholder AND used for citation-domain
-- evaluation). Mirrors the prompt_templates + prompt_versions pattern so the
-- policy can be edited in the prompt editor and reach the runtime (both the
-- Python backend and the Workers backend) without a redeploy.
--
-- `body` holds the canonical compact JSON of the policy object
-- ({deny,prefer,community_exception}); `sha256` is sha256(body) for optimistic
-- concurrency, matching how prompt_templates stores body + sha.
-- RLS + grants mirror prompt_templates_rls.sql (defense in depth; future tables
-- already inherit content_tool_app grants via ALTER DEFAULT PRIVILEGES).

CREATE TABLE IF NOT EXISTS content_tool.source_policy (
    policy_id    character varying NOT NULL,
    body         character varying NOT NULL,
    sha256       character varying NOT NULL,
    bytes        integer NOT NULL,
    updated_at   timestamp with time zone DEFAULT now() NOT NULL,
    updated_by   character varying
);

ALTER TABLE content_tool.source_policy OWNER TO postgres;

ALTER TABLE ONLY content_tool.source_policy
    ADD CONSTRAINT source_policy_pkey PRIMARY KEY (policy_id);

CREATE TABLE IF NOT EXISTS content_tool.source_policy_versions (
    version_id     "uuid" NOT NULL,
    policy_id      character varying NOT NULL,
    sha256         character varying NOT NULL,
    parent_sha256  character varying,
    body           character varying NOT NULL,
    bytes          integer NOT NULL,
    saved_by       character varying NOT NULL,
    saved_at       timestamp with time zone DEFAULT now() NOT NULL,
    kind           character varying DEFAULT 'save'::character varying NOT NULL
);

ALTER TABLE content_tool.source_policy_versions OWNER TO postgres;

ALTER TABLE ONLY content_tool.source_policy_versions
    ADD CONSTRAINT source_policy_versions_pkey PRIMARY KEY (version_id);

CREATE INDEX IF NOT EXISTS source_policy_versions_policy_idx
    ON content_tool.source_policy_versions USING btree (policy_id, saved_at);

-- Row Level Security: keep the tables inaccessible to anon / authenticated
-- Supabase roles if the schema is ever exposed, while granting full access to
-- postgres and the dedicated content_tool_app role.
ALTER TABLE content_tool.source_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_tool.source_policy_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY postgres_allow_all ON content_tool.source_policy          TO postgres         USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all      ON content_tool.source_policy          TO content_tool_app USING (true) WITH CHECK (true);
CREATE POLICY postgres_allow_all ON content_tool.source_policy_versions TO postgres         USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all      ON content_tool.source_policy_versions TO content_tool_app USING (true) WITH CHECK (true);

-- Seed the singleton 'default' policy from config/source_policy.yaml. The body
-- is the canonical compact JSON; sha256/bytes are computed over that exact text
-- (verified to match both the Python json.dumps(separators=(",",":")) and the
-- TypeScript JSON.stringify serializers). ON CONFLICT keeps re-applies idempotent
-- and never clobbers an edited live row.
INSERT INTO content_tool.source_policy (policy_id, body, sha256, bytes)
VALUES (
    'default',
    $sp${"deny":{"domains":["bowtie.com.hk","bowtie.com","manulife.com.hk","axa.com.hk","prudential.com.hk","aia.com.hk","china-life.com.hk","blueocean.com.hk","chubb.com.hk","zurich.com.hk","hsbclife.com.hk","fwd.com.hk"]},"prefer":{"tlds":[".gov.hk",".gov",".edu",".edu.hk"],"domains":["ia.org.hk","ifec.org.hk","hkma.gov.hk","dh.gov.hk","chp.gov.hk","ha.org.hk","mpfa.org.hk","vhis.gov.hk","who.int"]},"community_exception":{"topic_categories":["community-response","patient-experience","social-discussion"],"allowed_domains":["reddit.com","hk.discuss.com","lihkg.com","baby-kingdom.com"]}}$sp$,
    '6745574425f642c4c2390424d1d49cb624bcc398f74dabf0bb5735b8686885e8',
    585
)
ON CONFLICT (policy_id) DO NOTHING;
