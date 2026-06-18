-- Add Ghost CMS metadata to run snapshots so Save + version history
-- round-trips ghost author/tags/feature-image (was WordPress-only).
ALTER TABLE content_tool.hitl2_snapshots
  ADD COLUMN IF NOT EXISTS ghost_author_ids jsonb,
  ADD COLUMN IF NOT EXISTS ghost_tags       jsonb,
  ADD COLUMN IF NOT EXISTS feature_image_url text;
