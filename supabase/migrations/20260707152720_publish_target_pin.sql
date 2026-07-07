-- Publish-target pin (bowtie-ins issue #15).
--
-- Records the exact CMS target the reviewer confirmed at HITL_2 approve so the
-- publish step can assert it still resolves to the same post before writing.
-- approved_post_id is text: WP ids are numeric, Ghost ids are hex strings; NULL
-- with a non-null kind means "approved as create-new" (slug-change path).
-- Columns are set on approve of refresh runs and cleared on any other decision,
-- on a publish-time mismatch, and when existing-post/refresh re-resolves the
-- target to a different post.

ALTER TABLE content_tool.runs
  ADD COLUMN IF NOT EXISTS approved_target_kind text,
  ADD COLUMN IF NOT EXISTS approved_post_id text,
  ADD COLUMN IF NOT EXISTS approved_target_label text;
