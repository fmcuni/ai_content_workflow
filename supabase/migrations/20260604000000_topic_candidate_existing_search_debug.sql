-- Topic-dedup stage-1 observability.
--
-- The existing-article search (dedup stage 1) runs a grounded Gemini search,
-- HEAD-resolves the grounding chunks, and keeps the bowtie.com.hk hits. When it
-- returns an empty list the judge answers "no" — but an empty list has several
-- very different causes (grounding returned nothing, every resolve failed under
-- the Workers subrequest budget, all hits were competitors, the cap was hit).
-- Those were previously indistinguishable, so a real, live article could be
-- silently reported as "no article exists" with no trace.
--
-- This column persists the per-candidate stage-1 diagnostics (chunk count,
-- resolve attempts/failures, bowtie hits, cap-hit, retry fired) so every
-- "empty -> no" outcome is explainable after the fact. Nullable: rows written
-- before this migration, or candidates whose dedup call errored outright, leave
-- it NULL.
ALTER TABLE content_tool.topic_candidates
  ADD COLUMN IF NOT EXISTS existing_search_debug jsonb;

COMMENT ON COLUMN content_tool.topic_candidates.existing_search_debug IS
  'Dedup stage-1 (topic_existing_search) diagnostics: grounding chunk count, '
  'resolve attempts/failures, bowtie hits, cap-hit and retry flags. Explains why '
  'existing was decided, especially empty-candidate "no" verdicts.';
