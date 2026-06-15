-- Re-point bowtie-editor's stale, hardcoded writer/outline rows at the now-
-- tokenized '__shared__' bodies (in place — the rows stay owned by bowtie-editor).
--
-- Background: the original seed (20260529000001_prompt_templates.sql) inserted
-- these template bodies BEFORE the per-voice schema existed; the per-voice
-- migration then assigned them voice_slug='bowtie-editor'. The Voice Locale work
-- tokenized the canonical templates ({brand_name}/{output_language}/{market}) but
-- the catch-up reseed (20260616000001) writes ONLY voice_slug='__shared__'. That
-- left bowtie-editor pinned to the pre-tokenization, hardcoded bodies, so its
-- assembled prompt drifted from '__shared__' and the on-disk goldens.
--
-- Why UPDATE (not DELETE): bowtie-editor is the default voice and the rest of the
-- system expects it to OWN explicit per-voice rows — the /prompts editor PUTs an
-- UPDATE against them, and the template list asserts voice_slug='bowtie-editor'.
-- So we keep the rows but copy the tokenized '__shared__' body/sha256/bytes into
-- them. bowtie-editor is HK-ZH, so the writer/outline node resolves
-- {output_language}->香港繁體中文, {brand_name}->Bowtie — the final prompt is
-- BYTE-IDENTICAL; this only retokenizes the stored copy so it tracks the shared
-- seed-of-record again.
--
-- Scope: only the exact template_ids reseeded with tokens by 20260616000001, and
-- only where bowtie-editor already has a row (FROM-join updates nothing for
-- absent rows — those already fall back to '__shared__'). Other voices' localized
-- overrides (bowtie-zh-my / bowtie-en-my) are untouched. Idempotent: re-running
-- copies the same shared bytes.
UPDATE content_tool.prompt_templates AS pt
SET body = s.body,
    sha256 = s.sha256,
    bytes = s.bytes
FROM content_tool.prompt_templates AS s
WHERE pt.voice_slug = 'bowtie-editor'
  AND s.voice_slug = '__shared__'
  AND s.template_id = pt.template_id
  AND pt.template_id IN (
    '_writer_brand_block',
    '_writer_schema',
    'writer_create',
    'writer_full_rewrite',
    'writer_small_refresh',
    'outline_create_mode',
    'outline_rewrite_mode'
  );
