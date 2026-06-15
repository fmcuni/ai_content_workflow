-- Per-Voice Locale & Brand Portability (Phase A foundation).
-- Spec:  docs/superpowers/specs/2026-06-15-voice-locale-brand-portability.md
-- Plan:  docs/superpowers/plans/2026-06-15-voice-locale-brand-portability.md
--
-- Adds a single nullable-shaped JSONB column to the existing voice row so a
-- voice can carry its own output language, brand name, market, and
-- sources/FAQ headings as DATA instead of code. No new table — `personas`
-- already IS the voice (keyed by `slug`, loaded by `load_persona`).
--
-- Safe-to-push-first: the column is NOT NULL DEFAULT '{}'::jsonb, and the
-- `VoiceLocale` model's defaults exactly reproduce the current HK-ZH
-- (`bowtie-editor`) behaviour, so an empty `{}` locale is a no-op. The
-- currently deployed app — which does not yet read the column — is unaffected
-- during the deploy window (CLAUDE.md ordering invariant).
--
-- RLS/grants are inherited from the existing personas table policy (the column
-- adds no new object), so nothing else changes here.

ALTER TABLE content_tool.personas
  ADD COLUMN IF NOT EXISTS locale jsonb NOT NULL DEFAULT '{}'::jsonb;
