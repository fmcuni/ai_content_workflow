-- Rename the prompt-template key 'outline' -> 'outline_rewrite_mode'.
--
-- Why: the base outline template is the rewrite-mode brief (gap_analysis +
-- existing article + small_refresh/full_rewrite route). Renaming it to
-- 'outline_rewrite_mode' mirrors the existing 'outline_create_mode' sibling so
-- the /prompts editor and the prompt graph read symmetrically. Content is
-- UNCHANGED (same body, sha256, bytes) — this migration only renames the key
-- and its filename column. The runtime base template for BOTH modes stays this
-- row; create-mode still slots 'outline_create_mode' into its {create_mode_block}
-- placeholder (see content_tool/agents/outline.py / deploy/.../agents/outline.ts).
--
-- Forward-only and idempotent. Correct in two environments:
--
--   * PROD (`supabase db push`): only 'outline' rows exist (one per voice +
--     '__shared__'). The UPDATE renames each in place; the DELETE is a no-op.
--
--   * FRESH RESET / CI (`supabase db reset`): the frozen baseline
--     20260529000001 seeds 'outline' and the per-voice backfill 20260604172254
--     copies it into each voice, THEN the regenerated re-seed 20260605000001
--     inserts 'outline_rewrite_mode' under '__shared__'. So '__shared__' has
--     BOTH keys here while per-voice rows still have only 'outline'. The
--     guarded UPDATE renames the per-voice 'outline' rows (no 'outline_rewrite_mode'
--     yet for them) and skips '__shared__' (already has it); the DELETE then
--     drops the now-redundant '__shared__'/'outline' baseline row.
--
-- Re-running on an already-migrated DB finds no 'outline' rows -> both steps
-- no-op. Parity-safe: both backends read these rows from
-- content_tool.prompt_templates; deploy the renamed code AFTER this migration.

-- 1. Rename 'outline' -> 'outline_rewrite_mode' for every voice that does not
--    already carry the renamed key (prod: all rows; fresh reset: per-voice rows).
UPDATE content_tool.prompt_templates AS p
   SET template_id = 'outline_rewrite_mode',
       filename    = 'outline_rewrite_mode.md',
       updated_at  = now(),
       updated_by  = 'migration:rename_outline_to_rewrite_mode'
 WHERE p.template_id = 'outline'
   AND NOT EXISTS (
       SELECT 1
         FROM content_tool.prompt_templates AS q
        WHERE q.voice_slug = p.voice_slug
          AND q.template_id = 'outline_rewrite_mode'
   );

-- 2. Drop any leftover 'outline' rows (fresh-reset: the '__shared__' baseline
--    row whose renamed twin was already inserted by the re-seed). No-op on prod.
DELETE FROM content_tool.prompt_templates
 WHERE template_id = 'outline';

-- 3. Carry edit history forward so saved versions stay visible under the new
--    key. version_id is the PK, so renaming template_id never collides.
UPDATE content_tool.prompt_versions
   SET template_id = 'outline_rewrite_mode'
 WHERE template_id = 'outline';
