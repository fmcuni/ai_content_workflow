-- Realtime collab: Postgres cold-store / backup for the per-run merged Yjs doc.
-- Spec:  docs/superpowers/specs/2026-06-09-realtime-collab-per-author-attribution.md
-- Plan:  docs/superpowers/plans/2026-06-09-realtime-collab-per-author-attribution.md
--
-- The RunDoc Durable Object (deploy/cloudflare-workers/src/run-doc.ts) holds the
-- authoritative Yjs document for one run and debounce-persists it to DO storage.
-- DO storage is co-located with the DO instance, so a DO eviction/relocation can
-- lose it. This table is the durable backup: the DO UPSERTs the merged doc here
-- on each persist flush, and cold-loads from here when DO storage is empty.
--
-- One row per run (run_id PRIMARY KEY). `run_id` is uuid to match how runs are
-- keyed everywhere else (baseline runs.run_id, review_threads.run_id) and carries
-- a FK to content_tool.runs with ON DELETE CASCADE so the backup is cleaned up
-- with the run (mirrors review_threads).
--
-- RLS + grants mirror review_threads.sql / run_event_logs.sql: RLS enabled as
-- defense in depth, explicit GRANT + allow-all policy for the content_tool_app
-- role. Additive + new-table => behaviour-neutral for the runtime.

CREATE TABLE IF NOT EXISTS content_tool.run_collab_state (
    run_id        uuid PRIMARY KEY
                      REFERENCES content_tool.runs (run_id) ON DELETE CASCADE,
    -- Full Yjs state update (Y.encodeStateAsUpdate) — the merged document.
    ydoc          bytea NOT NULL,
    -- Yjs state vector (Y.encodeStateVector); nullable, used for diff sync.
    state_vector  bytea,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- RLS as defense in depth, consistent with every other content_tool table.
ALTER TABLE content_tool.run_collab_state ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON content_tool.run_collab_state TO content_tool_app;

CREATE POLICY app_allow_all ON content_tool.run_collab_state
    TO content_tool_app USING (true) WITH CHECK (true);
