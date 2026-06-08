# Spec — Version-history baselines + "current" marker + better history UX

**Date:** 2026-06-09
**Status:** Draft → in implementation
**Surfaces:** Prompt templates (`/prompts`), Source policy (`/prompts` → Source Policy tab), Run content (HITL_2 galley / edit)
**Backends:** Python (`content_tool/`) **and** Workers TS port (`deploy/cloudflare-workers/`) — must stay at parity.

## Problem

Today version history starts **empty** and never tells you which entry is live:

1. **Prompt templates + source policy** — history rows in `prompt_versions` /
   `source_policy_versions` are written only on **save** (`kind='save'`) or
   **revert** (`kind='revert'`). The seed-of-record set (`__shared__` + the
   originally-seeded voices) is inserted by SQL seed migrations
   (`scripts/gen_prompt_seed.py`) with **no matching version row**, so the
   panel shows *"No saves yet…"* and the **pristine seeded body is
   unrecoverable** until someone edits it. (New-voice duplication already seeds
   a baseline — `personas.duplicate_persona` — so only the seed-of-record set
   and pre-existing rows need backfill.)
2. **Run content (HITL_2)** — `hitl2_snapshots` only holds reviewer autosaves.
   The **AI's original generated draft** lives in `renders`/`drafts`, never as a
   snapshot, so it can't be diffed or restored. Panel shows *"No saved versions
   yet."* until the first autosave.
3. **"Current" is invisible.** For prompts it's implicit only (the Revert
   button is disabled when `version.sha256 === live sha`); there's no badge. For
   runs there's no marker at all.

## Goals

| # | Goal |
|---|------|
| 1 | Sequential, human version numbers (`v1, v2, …`) in every history list. |
| 2 | A **"● Live"** badge on the current entry, pinned/visually distinct. |
| 3 | An always-present **baseline v1** entry: `kind='seed'` for prompts/policy, `trigger='generated'` for runs. Never an empty list; pristine state always restorable. |
| 4 | **Diff-against-current** when opening a version (inline/side-by-side), not just raw body. |
| 5 | Optional one-line **change note** on manual saves (author already captured). |
| 6 | **Unified run timeline** — AI baseline + regenerate iterations (`drafts`) + reviewer snapshots read as one chronology. |

## Non-goals

- No new auth/roles model (existing RBAC unchanged: revert = admin for prompts).
- No change to the runtime source of truth (`prompt_templates.body` /
  `renders` stay authoritative; history remains an append-only audit trail).
- No Langfuse / prompt-management coupling.

## Data model

`kind` (prompt/policy versions) and `trigger` (hitl2 snapshots) are free
varchars with **no CHECK constraint** (`baseline.sql:273`), so new values
(`'seed'`, `'generated'`) need **no column migration** — only a data backfill +
going-forward writes.

- **`kind='seed'`** — one row per live `prompt_templates` / `source_policy` row
  that currently has no history, body byte-identical to the live body,
  `parent_sha256=NULL`, `saved_by='system:seed'`.
- **`trigger='generated'`** — one baseline `hitl2_snapshots` row per run that has
  reached HITL_2, derived from the run's `renders` row (html_body + seo_title +
  meta_description + default WP fields), `created_by='system:generated'`.
- **Change note** — reuse the existing optional `notes` field for hitl2; for
  prompt/policy add an optional `note` to the save request, persisted in a new
  nullable `note` column on `*_versions` (small additive migration).

## "current" semantics

- **Prompts/policy:** the history row whose `sha256` equals the live row's
  `sha256`. After a revert the live sha matches the revert row (newest), so the
  Live badge tracks correctly. If no row matches (legacy, pre-backfill), none is
  marked. Exposed as `is_current: bool` on each `/history` entry.
- **Runs:** the snapshot whose `html_body` (+ key metadata) matches the current
  working/persisted render. Simpler: mark the most-recently-restored-or-saved
  snapshot; otherwise label the live editor state explicitly above the list.

## API changes

- `GET /prompts/templates/{id}/history` and `GET /source-policy/history` and
  `GET /runs/{id}/hitl2-snapshots`: each entry gains `version_number: int` and
  `is_current: bool`. Lists stay newest-first; `version_number` is computed
  oldest=1.
- `GET /runs/{id}/hitl2-snapshots`: lazily ensures a `trigger='generated'`
  baseline exists (idempotent check-then-insert from the render) before
  returning — identical logic in both backends.
- Save endpoints accept optional `note: str | None`.

## Acceptance

- Fresh template/policy/run with zero edits shows exactly one **v1** entry
  labeled seed/generated, badged **● Live**.
- After N saves, list shows `v1 … v(N+1)`, newest first, Live badge on the live
  one; reverting moves the badge.
- Opening any non-current version shows a diff vs current.
- Python unit + Workers Vitest + web Vitest + a Playwright smoke all green;
  Python↔TS canonical-body sha parity preserved.
- Backfill migration is idempotent (re-runnable) and rehearsed on `db reset`.
