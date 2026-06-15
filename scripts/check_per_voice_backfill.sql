-- Post-migration assertion for the Per-Voice Prompt Library backfill.
-- Spec/Plan: docs/design/{specs,plans}/2026-06-05-per-voice-prompt-library.md
--
-- Run AFTER `supabase db reset` (i.e. after supabase/seed.sql seeds personas) to
-- validate the post-seed state — the in-migration DO block only sees personas
-- that exist at migration time, which is empty on a fresh local reset.
--
-- Asserts: every non-archived persona has the FULL agent+partial template set
-- AND exactly one source_policy row; judges remain global under '__shared__'.
-- Prints the counts, then RAISEs if any invariant is violated.
--
-- Usage (local):
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" \
--        -f scripts/check_per_voice_backfill.sql

\echo '== Per-voice prompt-library backfill counts =='

-- Shared seed-of-record set (agent + partial) and global judges.
SELECT category, count(*) AS shared_rows
FROM content_tool.prompt_templates
WHERE voice_slug = '__shared__'
GROUP BY category
ORDER BY category;

-- Per-voice template counts for each non-archived persona.
SELECT t.voice_slug, count(*) AS agent_partial_rows
FROM content_tool.prompt_templates t
JOIN content_tool.personas p ON p.slug = t.voice_slug AND p.is_archived = false
WHERE t.category IN ('agent', 'partial')
GROUP BY t.voice_slug
ORDER BY t.voice_slug;

-- Per-voice source_policy row counts.
SELECT s.voice_slug, count(*) AS policy_rows
FROM content_tool.source_policy s
GROUP BY s.voice_slug
ORDER BY s.voice_slug;

DO $assert$
DECLARE
    shared_set_count integer;
    persona_count    integer;
    bad_templates    integer;
    bad_policy       integer;
    judge_count      integer;
BEGIN
    SELECT count(*) INTO shared_set_count
    FROM content_tool.prompt_templates
    WHERE voice_slug = '__shared__' AND category IN ('agent', 'partial');

    SELECT count(*) INTO judge_count
    FROM content_tool.prompt_templates
    WHERE category = 'judge';

    SELECT count(*) INTO persona_count
    FROM content_tool.personas WHERE is_archived = false;

    SELECT count(*) INTO bad_templates
    FROM content_tool.personas p
    WHERE p.is_archived = false
      AND (
        SELECT count(*) FROM content_tool.prompt_templates t
        WHERE t.voice_slug = p.slug AND t.category IN ('agent', 'partial')
      ) <> shared_set_count;

    SELECT count(*) INTO bad_policy
    FROM content_tool.personas p
    WHERE p.is_archived = false
      AND (
        SELECT count(*) FROM content_tool.source_policy s
        WHERE s.voice_slug = p.slug
      ) <> 1;

    -- Judges must NOT be duplicated per voice — they stay global.
    IF EXISTS (
        SELECT 1 FROM content_tool.prompt_templates
        WHERE category = 'judge' AND voice_slug <> '__shared__'
    ) THEN
        RAISE EXCEPTION 'judges must remain global under __shared__';
    END IF;

    RAISE NOTICE 'shared agent/partial set = %; global judges = %; non-archived personas = %',
        shared_set_count, judge_count, persona_count;

    IF persona_count = 0 THEN
        RAISE EXCEPTION 'no non-archived personas found — seed.sql did not run?';
    END IF;
    IF bad_templates > 0 THEN
        RAISE EXCEPTION '% persona(s) missing agent/partial templates', bad_templates;
    END IF;
    IF bad_policy > 0 THEN
        RAISE EXCEPTION '% persona(s) without exactly one source_policy row', bad_policy;
    END IF;

    RAISE NOTICE 'OK: every non-archived persona has the full agent/partial set + one source_policy row';
END
$assert$;
