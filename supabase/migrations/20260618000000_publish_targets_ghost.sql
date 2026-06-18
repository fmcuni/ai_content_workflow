-- Widen publish_targets.kind to allow Ghost (Pro) targets, and add a
-- CMS-agnostic post-id column. Ghost post ids are UUID strings, so they cannot
-- reuse runs.wp_pushed_post_id (integer). Additive + backward-compatible:
-- existing rows are unaffected and old code never references the new column, so
-- this is safe to push BEFORE the code that SELECTs cms_post_id deploys.
BEGIN;

ALTER TABLE content_tool.publish_targets
  DROP CONSTRAINT IF EXISTS publish_targets_kind_check;

ALTER TABLE content_tool.publish_targets
  ADD CONSTRAINT publish_targets_kind_check CHECK (kind IN ('wordpress', 'ghost'));

-- Non-WordPress CMS post id (e.g. a Ghost post UUID) recorded after a
-- successful publish so a re-push updates the same post. NULL for WordPress
-- runs (which use wp_pushed_post_id) and for un-published runs.
ALTER TABLE content_tool.runs
  ADD COLUMN IF NOT EXISTS cms_post_id text;

COMMENT ON COLUMN content_tool.runs.cms_post_id IS
  'Non-WordPress CMS post id (e.g. Ghost UUID). WordPress runs use wp_pushed_post_id.';

COMMIT;
