-- Review threads: human-only highlight discussions (comment / reply / resolve).
--
-- A SEPARATE pipeline from the AI-edit "comments" (which live in
-- hitl2_snapshots.comments jsonb and feed apply-edits). Review threads are never
-- dispatched to the AI; they are persisted here so reply/resolve history survives
-- across snapshot versions and supports multi-author replies.
--
-- Anchored to the article body via `anchor_id`, which matches the
-- data-review-id attribute on the highlight <span> in the rendered/edited HTML.

CREATE TABLE IF NOT EXISTS content_tool.review_threads (
    thread_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id            uuid NOT NULL
                          REFERENCES content_tool.runs (run_id) ON DELETE CASCADE,
    anchor_id         varchar NOT NULL,
    anchor_text       varchar,
    status            varchar NOT NULL DEFAULT 'open',
    -- [{ id, author_email, author_name, body, created_at }]
    messages          jsonb   NOT NULL DEFAULT '[]'::jsonb,
    created_by        varchar,
    created_by_name   varchar,
    created_at        timestamptz NOT NULL DEFAULT now(),
    resolved_by       varchar,
    resolved_by_name  varchar,
    resolved_at       timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_threads_run_idx
    ON content_tool.review_threads (run_id, created_at);

-- RLS as defense in depth, consistent with every other content_tool table.
ALTER TABLE content_tool.review_threads ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON content_tool.review_threads TO content_tool_app;

CREATE POLICY app_allow_all ON content_tool.review_threads
    TO content_tool_app USING (true) WITH CHECK (true);
