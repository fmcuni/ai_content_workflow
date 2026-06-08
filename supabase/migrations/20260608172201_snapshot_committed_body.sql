-- Tracked-changes baseline for HUMAN edits.
--
-- `committed_html_body` is the last "committed" version of the article body.
-- The diff between it and `html_body` (the working body) is the set of pending
-- human tracked changes the reviewer can commit / dismiss. NULL means there are
-- no pending changes (committed === html_body). Backfilled NULL on existing
-- rows — readers coalesce NULL to `html_body`.

ALTER TABLE content_tool.hitl2_snapshots
    ADD COLUMN IF NOT EXISTS committed_html_body varchar;
