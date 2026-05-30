-- Carry the article's structured-data graph (FAQPage, DefinedTermSet, ...) out
-- of the WordPress post body and into a dedicated column.
--
-- Previously render_html prepended a raw <script type="application/ld+json">
-- block to the post content. That produced a stray leading blank line and
-- "invalid markup" warnings in the Gutenberg/block editor. We now persist the
-- schema graph here instead; the publish step ships it to a registered post
-- meta key (_bowtie_schema_jsonld) and a companion Yoast/RankMath schema filter
-- on the WordPress side merges it into the page <head> graph.
--
-- Nullable + additive: existing rows keep NULL (no schema) and table-level RLS
-- already in force on content_tool.renders covers the new column.
ALTER TABLE "content_tool"."renders"
    ADD COLUMN IF NOT EXISTS "schema_jsonld" "jsonb";
