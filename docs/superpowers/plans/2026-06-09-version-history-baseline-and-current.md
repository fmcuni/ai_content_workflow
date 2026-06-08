# Plan — Version-history baselines + "current" marker + better UX

**Spec:** `docs/superpowers/specs/2026-06-09-version-history-baseline-and-current.md`
**Date:** 2026-06-09

Implemented in phases; each phase is independently shippable and TDD-first.
Python and Workers TS change together (parity gate:
`node deploy/cloudflare-workers/parity/check-parity.mjs`).

## Status (2026-06-09)
- **Phases 1–4 DONE** (both backends + frontend), static-verified: PY ruff +
  pyright (no new errors over baseline), Workers tsc + 378 Vitest, web tsc +
  234 Vitest (incl. new `Hitl2VersionHistory.test.tsx`). Migration written;
  `note` column added to both `*_versions` (ORM + TS schema). All four
  version-**detail** endpoints now return `note` for parity.
- **OWED (Docker down locally):** `supabase db reset` + the new Python
  integration tests (`tests/integration/test_hitl2_snapshots.py::
  test_list_stamps_version_number_and_is_current` /
  `test_generated_baseline_seeded_from_render`) + the parity gate — run in CI or
  when Docker is up. Plus a browser eyeball of the three history panels.
- **REMAINING: Phase 5 (diff-against-current)** and **Phase 6 (note INPUT UI +
  unified run timeline).** The `note` field is fully plumbed through DB + API +
  types + read-display; only the save-time input control is deferred.

## Phase 1 — Backfill + baseline seeding (foundation)
1. **Migration** `20260610000000_version_history_baselines.sql`:
   - Insert `kind='seed'` into `prompt_versions` for every `(voice_slug,
     template_id)` in `prompt_templates` lacking any version row.
   - Insert `kind='seed'` into `source_policy_versions` for every `voice_slug`
     in `source_policy` lacking any version row.
   - Add nullable `note` column to both `*_versions` tables.
   - Idempotent (`NOT EXISTS` guards); re-runnable.
2. **No change to `scripts/gen_prompt_seed.py`.** The reseed migration
   (`20260605000001`) runs *before* this backfill (`20260610000000`) in
   timestamp order, and the backfill is `NOT EXISTS`-guarded, so on every
   `supabase db reset` the reseeded `__shared__` rows get their baseline from the
   backfill automatically. Touching the frozen generator (with its equality
   assertion) would add risk for no `db reset` benefit. (Known pre-existing,
   out-of-scope gap: a reseed `ON CONFLICT DO UPDATE` body change writes no
   version row — separate concern.)
3. Tests: migration applies clean on `supabase db reset`; unit test asserting a
   freshly-seeded template has exactly one `seed` version.

## Phase 2 — `is_current` + `version_number` on history APIs
- Python: `prompts.py`, `source_policy.py` `/history` — compute
  `version_number` (oldest=1) and `is_current` (sha == live sha). Same for
  `runs.py` hitl2-snapshots (match on html_body/metadata).
- Workers TS mirror in `src/routes/{prompts,source_policy,runs}.ts`.
- Tests: Python unit + Vitest for both.

## Phase 3 — Run baseline snapshot (`trigger='generated'`)
- `runs.py` `GET /{id}/hitl2-snapshots`: lazy idempotent insert of a
  `trigger='generated'` snapshot from the render when none exists.
- Workers TS mirror.
- Add `'generated'` to `Hitl2SnapshotTrigger` + `TRIGGER_LABEL`.
- Tests both backends.

## Phase 4 — Frontend: numbers, Live badge, baseline label
- `Hitl2VersionHistory.tsx`, `prompts/[templateId]/page.tsx`,
  `SourcePolicyEditor.tsx`: render `v{n}`, pin/badge `● Live`, label
  seed/generated baseline; never show empty when a baseline exists.
- `lib/types.ts` + `lib/api.ts`: add fields.
- Vitest + a Playwright smoke.

## Phase 5 — Diff-against-current
- Lightweight inline diff (reuse existing dep if present, else a tiny
  line-diff util) in the version-preview dialog for all three surfaces.
- Vitest for the diff util.

## Phase 6 — Change note + unified run timeline
- Optional `note` on manual-save flows (prompts/policy/run).
- Run timeline: merge `drafts` (regenerate iterations) + `hitl2_snapshots` into
  one ordered list in the history panel.
- Tests + Playwright.

## Rollout
- Migration pushed to prod **before** code deploy (additive + backfill, safe).
- Behavior-neutral when unused (baseline rows are pure history).
- Rollback: history rows are append-only and ignorable; `note` column nullable.
- Deploy both Workers; prod smoke; update MEMORY.
