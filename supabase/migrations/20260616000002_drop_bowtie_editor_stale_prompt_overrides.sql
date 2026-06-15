-- Drop bowtie-editor's stale, hardcoded copies of the writer/outline templates
-- so it falls back to the now-tokenized '__shared__' rows.
--
-- Background: the original seed (20260529000001_prompt_templates.sql) inserted
-- these template bodies BEFORE the per-voice schema existed; the per-voice
-- migration then assigned them voice_slug='bowtie-editor'. The Voice Locale work
-- tokenized the canonical templates ({brand_name}/{output_language}/{market}) but
-- the catch-up reseed (20260616000001) writes ONLY voice_slug='__shared__'. That
-- left bowtie-editor pinned to the pre-tokenization, hardcoded bodies, so its
-- assembled prompt drifted from '__shared__' and the on-disk goldens.
--
-- bowtie-editor is the default HK-ZH voice, so its VoiceLocale resolves
-- {output_language}->香港繁體中文, {brand_name}->Bowtie at the writer/outline node.
-- Falling back to the tokenized '__shared__' therefore yields a BYTE-IDENTICAL
-- final prompt — this is a no-op for generated output, it just removes the
-- redundant per-voice override that no longer tracks the shared seed-of-record.
--
-- Scope: deletes ONLY voice_slug='bowtie-editor' rows for the exact template_ids
-- reseeded with tokens by 20260616000001. Other voices' intentional per-voice
-- overrides (e.g. bowtie-zh-my / bowtie-en-my localized bodies) are untouched.
-- Idempotent: re-running deletes nothing once the rows are gone.
DELETE FROM content_tool.prompt_templates
WHERE voice_slug = 'bowtie-editor'
  AND template_id IN (
    '_writer_brand_block',
    '_writer_schema',
    'writer_create',
    'writer_full_rewrite',
    'writer_small_refresh',
    'outline_create_mode',
    'outline_rewrite_mode'
  );
