-- Ghost post ids are UUID strings (not the integer wp_post_id). Store the
-- resolved Ghost post id so a Ghost refresh can UPDATE the existing post.
ALTER TABLE content_tool.fetched_articles
  ADD COLUMN IF NOT EXISTS cms_post_id text;
