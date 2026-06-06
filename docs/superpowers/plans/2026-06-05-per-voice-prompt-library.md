# Per-Voice Prompt Library & Source Policy — Implementation Plan

**Date:** 2026-06-05
**Spec:** [specs/2026-06-05-per-voice-prompt-library.md](../specs/2026-06-05-per-voice-prompt-library.md)

Scopes `prompt_templates` (agent+partial) and `source_policy` **per voice**
(persona slug), keeps judges global, makes new voices a **duplicate** of an
existing one, and forbids deleting the **last** voice. Voice key = persona
`slug`; reserved sentinel `__shared__` for global/seed rows.

> **Hard ordering:** migration pushed to DB **before** new-column-reading code
> is deployed. Python ↔ TS **sha parity** for prompt assembly + source-policy
> JSON is a release gate.

---

## Phase 0 — Confirm + freeze design (no code) ✅ resolved 2026-06-05
- [x] Seed-of-record: **keep canonical agent/partial set under `__shared__`**
      (fallback `voice → __shared__ → file`).
- [x] `source_policy.policy_id`: **dropped**; PK repurposed to `voice_slug`.
- [x] Topic-expansion voice resolution = `candidate.persona_slug ||
      batch.persona_default || 'bowtie-editor'`.

## Phase 1 — DB migration (TDD: write the backfill assertions first)
`supabase migration new per_voice_prompt_library`
- [ ] `prompt_templates`: add `voice_slug TEXT NOT NULL DEFAULT '__shared__'`;
      drop old PK; add PK `(voice_slug, template_id)`; index `voice_slug`.
- [ ] Backfill: `INSERT … SELECT p.slug, t.* FROM personas p CROSS JOIN
      (current agent/partial rows where voice_slug='__shared__') t` for every
      non-archived persona. Judges remain `__shared__`.
- [ ] `prompt_versions`: add `voice_slug` (+ default `__shared__`); backfill
      existing rows to `__shared__`; index `(voice_slug, template_id, saved_at)`.
- [ ] `source_policy`: add `voice_slug`; backfill the `default` body into one
      row per persona (+ retain a `__shared__` seed row); repoint PK to
      `voice_slug`.
- [ ] `source_policy_versions`: add `voice_slug`; backfill; index.
- [ ] RLS/grants parity for new columns (mirror existing `*_rls` migrations).
- [ ] Post-migration assertions: every non-archived persona has the full
      agent+partial set **and** exactly one source-policy row.
- [ ] `supabase db reset` locally → green.

## Phase 2 — Seed generation
- [ ] Update `scripts/gen_prompt_seed.py` to emit agent/partial rows under
      `voice_slug='__shared__'` (judges already shared); `ON CONFLICT
      (voice_slug, template_id) DO NOTHING`.
- [ ] Ensure `supabase/seed.sql` (personas) ordering still precedes template
      backfill, or make the migration self-contained for fresh installs.

## Phase 3 — Python runtime loaders + agents (TDD)
- [ ] `prompts_store.py`: `TemplateRow.voice_slug`; cache key `(voice, id)`;
      `get_assembled(id, *, voice_slug, session)`; `get_assembled_standalone(id,
      *, voice_slug)`; include resolution within-voice; fallback
      `voice → __shared__ → file`. Unit tests for fallback + within-voice includes.
- [ ] `source_policy_store.py`: `snapshot(voice_slug, session)` /
      `get_policy(voice_slug, session)`; fallback `voice → __shared__ → YAML`.
- [ ] Agent call sites pass the voice: `writer.py`, `audit.py`, `outline.py`
      (×2), `gap_analysis.py`, `apply_edits.py`; `topic_*` thread the batch voice.
- [ ] Golden-fixture tests still pass (assembled prompts byte-identical for
      `bowtie-editor`).

## Phase 4 — Python API routes (TDD)
- [ ] `prompts.py`: `voice` query param (default `bowtie-editor`) on all template
      endpoints; judges → `__shared__`; per-`(voice,id)` history/revert/preview.
- [ ] `source_policy.py`: `voice` param on all endpoints.
- [ ] `personas.py`:
      - `POST /personas/{slug}/duplicate` (atomic clone: persona + agent/partial
        templates + source policy + seed version rows). 409 on dup slug.
      - last-voice archive guard (409).
- [ ] Route tests incl. 409 paths.

## Phase 5 — Workers TS mirror (parity)
- [ ] `prompts/store.ts`, `db/prompts.ts`, `routes/prompts.ts` — voice scoping +
      fallback.
- [ ] `source_policy/store.ts`, `routes/source_policy.ts` — voice scoping.
- [ ] `db/personas.ts`, `routes/personas.ts` — duplicate endpoint + last-voice guard.
- [ ] `production.ts` / agent equivalents pass the run/batch voice.
- [ ] `node deploy/cloudflare-workers/parity/check-parity.mjs` green; `tsc` clean.

## Phase 6 — Web UI
- [ ] `/web/app/prompts/page.tsx`: voice selector; Prompt Library scoped to voice;
      "Shared (judges)" read-only group; Source Policy tab scoped to voice; all
      API calls pass `?voice=`.
- [ ] `web/lib` API client: add `voice` arg to prompts + source-policy calls.
- [ ] `/web/app/voices/page.tsx` + `ComposeDrawer`/`CopyToVoiceDialog`: new-voice
      flow = duplicate (source voice + new slug/name); disable archive on last voice.
- [ ] Vitest/RTL for the duplicate dialog + last-voice-disabled state.

## Phase 7 — Verify, review, ship
- [ ] `ruff check .`, `pyright` (no new errors in touched files), `pytest` green.
- [ ] `cd web && npx tsc --noEmit && npm run lint && npx vitest run`.
- [ ] Playwright smoke: select voice → edit a template → edit source policy →
      duplicate a voice → confirm last-voice archive blocked. (Use a dedicated
      port, not shared :3000.)
- [ ] code-review + security-review agents.
- [ ] `supabase db push` (prod) **before** deploy; deploy both Workers; smoke prod.
- [ ] Conventional-commit PR; update MEMORY.md.

---

## Risk register
| Risk | Mitigation |
|---|---|
| Sha parity drift Python↔TS | parity gate in Phase 5; no serializer change |
| Migration backfill misses a voice | Phase 1 post-assertions; `db reset` rehearsal |
| Topic expansion has no voice | default `bowtie-editor` resolution rule |
| Voice missing a newly-added template | `__shared__` → file fallback in loaders |
| Deploy before migration | enforce push-first; loaders tolerate missing column via fallback during window |
| Duplicate endpoint partial failure | wrap clone in a single transaction |
