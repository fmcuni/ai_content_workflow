-- Append-only verbose per-step event log for the 3 interactive run types
-- (Refresh, Expand Topics / Front II, Create New Articles / Front III).
--
-- Every event that flows through the SSE emit choke points is persisted here so
-- a finished or failed run can be debugged after the fact (today the SSE history
-- is in-memory only: a 500-event deque in Python, a 500-event Durable Object
-- buffer in Workers, both lost on restart).
--
-- One table serves BOTH runs and topic batches: `stream_id` is the run_id OR the
-- batch_id, disambiguated by `stream_kind`. No foreign key (two possible parent
-- tables) — cleanup is explicit in the run/batch delete routes of both backends.
--
-- Verbosity is "full payloads + raw thinking": *.start / *.done / *.thinking /
-- hitl.interrupted / graph.completed|error are all stored. Safety valves live in
-- the application layer (batched writes, a per-payload size cap, a
-- PERSIST_THINKING toggle).
--
-- RLS + grants mirror source_policy.sql (defense in depth; future tables already
-- inherit content_tool_app grants via ALTER DEFAULT PRIVILEGES).

CREATE TABLE IF NOT EXISTS content_tool.run_event_logs (
    log_id       "uuid" DEFAULT gen_random_uuid() NOT NULL,
    stream_id    "uuid" NOT NULL,
    stream_kind  character varying DEFAULT 'run'::character varying NOT NULL,
    seq          bigint NOT NULL,
    event        character varying NOT NULL,
    level        character varying DEFAULT 'info'::character varying NOT NULL,
    step         character varying,
    iteration    integer,
    duration_ms  integer,
    payload      "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    recorded_at  timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_event_logs_stream_kind_check
        CHECK (stream_kind IN ('run', 'batch')),
    CONSTRAINT run_event_logs_level_check
        CHECK (level IN ('info', 'thinking', 'gate', 'error'))
);

ALTER TABLE content_tool.run_event_logs OWNER TO postgres;

ALTER TABLE ONLY content_tool.run_event_logs
    ADD CONSTRAINT run_event_logs_pkey PRIMARY KEY (log_id);

-- Monotonic ordering per stream; also the idempotency key for the Workers DO
-- alarm-driven batch flush (ON CONFLICT (stream_id, seq) DO NOTHING).
ALTER TABLE ONLY content_tool.run_event_logs
    ADD CONSTRAINT run_event_logs_stream_seq_key UNIQUE (stream_id, seq);

-- Primary read path: fetch a stream's log ordered by seq, optionally since_seq.
CREATE INDEX IF NOT EXISTS run_event_logs_stream_idx
    ON content_tool.run_event_logs USING btree (stream_id, seq);

ALTER TABLE content_tool.run_event_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY postgres_allow_all ON content_tool.run_event_logs TO postgres         USING (true) WITH CHECK (true);
CREATE POLICY app_allow_all      ON content_tool.run_event_logs TO content_tool_app USING (true) WITH CHECK (true);
