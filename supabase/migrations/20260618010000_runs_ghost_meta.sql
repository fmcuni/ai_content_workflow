-- Ghost-specific HITL_2 metadata on runs, parallel to the wp_* columns.
-- Ghost authors are staff-user UUIDs (string), tags are names (Ghost matches/
-- auto-creates by name), and the feature image is a URL (Ghost has no numeric
-- media id). feature_image_url also backs the new image-upload result for
-- Ghost runs; WordPress runs keep using wp_featured_media_id.
--
-- Additive + nullable → backward-compatible. Per the split-migration rule this
-- must be applied to dev + prod BEFORE deploying code that SELECTs these
-- columns (loadHitl2Options).
BEGIN;

-- Arrays stored as jsonb to match the wp_category_ids/wp_tag_ids convention
-- (written via toJsonb, read via a string-array coercion helper).
ALTER TABLE content_tool.runs
  ADD COLUMN IF NOT EXISTS ghost_author_ids jsonb,
  ADD COLUMN IF NOT EXISTS ghost_tags jsonb,
  ADD COLUMN IF NOT EXISTS feature_image_url text;

COMMENT ON COLUMN content_tool.runs.ghost_author_ids IS
  'Ghost staff-user ids selected as post authors (first = primary). WordPress runs use wp_author_id.';
COMMENT ON COLUMN content_tool.runs.ghost_tags IS
  'Ghost tag names; matched-or-auto-created on publish. WordPress runs use wp_tag_ids.';
COMMENT ON COLUMN content_tool.runs.feature_image_url IS
  'Feature/featured image URL (Ghost feature_image; also the upload result URL). WordPress runs use wp_featured_media_id.';

COMMIT;
