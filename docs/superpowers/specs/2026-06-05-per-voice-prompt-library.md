# Per-Voice Prompt Library & Source Policy — Design Spec

**Date:** 2026-06-05
**Status:** Draft (awaiting review)
**Author:** (pairing session)

## Summary

Today the Prompt Library (`content_tool.prompt_templates`) and the Source Policy
(`content_tool.source_policy`) are **global singletons** — one shared set of
prompt templates and one shared source policy feed every run regardless of which
**voice** (persona) the run uses. This change scopes both **under a voice**, so
each voice carries its own editable agent prompts, partials, and source policy
(the `{source_policy_block}` placeholder). Judges stay global. Creating a new
voice **duplicates** an existing one, and the **last remaining voice cannot be
deleted/archived**.

"Voice" === the existing **persona** concept (`content_tool.personas`, the
`/voices` page). A voice is identified by its `slug` (unique). The default
seeded voice is **`bowtie-editor`** (`config/personas/bowtie-editor.yaml`,
`supabase/seed.sql`).

## Requirements (verbatim, with interpretation)

1. **"Under prompt: `{source_policy_block}` should be editable."**
   → Source policy becomes **per-voice**. Each voice has its own editable source
   policy (still edited via the structured `deny`/`prefer`/`community_exception`
   JSON form → rendered to `{source_policy_block}` by `to_prompt_block()`). The
   writer prompt for a run resolves `{source_policy_block}` from **that run's
   voice's** policy.

2. **"All prompt templates (Prompt Library) should be under a voice. Each voice
   could have different prompt templates."**
   → `prompt_templates` becomes per-voice for categories **`agent`** and
   **`partial`**. Judges (`category='judge'`) **stay global** (shared, read-only
   eval prompts). Each voice gets its own copy of the agent+partial set, edited
   and version-tracked independently.

3. **"Creating new voice should be duplicating an existing one. Last existing
   one could not be deleted."**
   → New voice = deep-copy of a source voice: the persona row + that voice's
   agent/partial templates + that voice's source policy, under a new slug/name.
   Archiving the **last non-archived** voice is rejected (409).

## Current state (as-built)

### Prompt templates
- Table `content_tool.prompt_templates`: **PK = `template_id`**; cols
  `category` (`agent`|`partial`|`judge`), `filename`, `body`, `sha256`,
  `bytes`, `updated_at`, `updated_by`.
- History `content_tool.prompt_versions`: keyed by `template_id`
  (`version_id` PK, `sha256`, `parent_sha256`, `body`, `bytes`, `saved_by`,
  `saved_at`, `kind`).
- Runtime loaders:
  - Python `content_tool/prompts_store.py` — `snapshot()` caches the whole
    table by `template_id`; `get_assembled(template_id, session)` resolves
    `{{include:NAME}}` partials byte-for-byte; `get_assembled_standalone(id)`
    for agents without a session (`topic_*`).
  - Workers `deploy/cloudflare-workers/src/prompts/store.ts` — mirror
    (`snapshot` → `Map<template_id, row>`, `resolveBody`, `assembleFromSnapshot`).
- API: `content_tool/api/routes/prompts.py` + `deploy/cloudflare-workers/src/routes/prompts.ts`
  — `GET/PUT /prompts/templates[/{id}][/schema|consumers|history|versions|preview|revert]`.
  Editable categories = `{agent, partial}`; judges read-only.
- Seed: `scripts/gen_prompt_seed.py` scans `prompts/*.md` + `evals/judge/*.md`
  into a migration with `ON CONFLICT DO NOTHING`.
- Agent call sites (Python) already hold the voice: `run.persona` /
  `persona_name` in `writer.py`, `audit.py`, `outline.py`, `apply_edits.py`,
  `gap_analysis.py`. `topic_*` agents use `get_assembled_standalone()` with **no
  voice** today, but topic batches carry `batch.persona_default`
  (default `"bowtie-editor"`) and per-candidate `persona_slug`
  (`content_tool/api/routes/topic_batches.py:580`).

### Source policy
- Table `content_tool.source_policy`: **singleton PK `policy_id='default'`**;
  `body` (canonical compact JSON), `sha256`, `bytes`, `updated_*`.
- History `content_tool.source_policy_versions`: keyed by `policy_id`.
- Loaders: `content_tool/source_policy_store.py` + Workers
  `deploy/cloudflare-workers/src/source_policy/store.ts` — both fall back to
  `config/source_policy.yaml`. The canonical JSON serializer is **byte-identical
  Python↔TS** (sha parity is a hard invariant).
- Render: `SourcePolicy.to_prompt_block()` → `{source_policy_block}`.
- API: `content_tool/api/routes/source_policy.py` +
  `deploy/cloudflare-workers/src/routes/source_policy.ts`
  — `GET/PUT /source-policy`, `/preview`, `/versions[/{id}]`, `/revert`.

### Personas / voices
- Table `content_tool.personas` (`content_tool/db/persona_model.py`): `persona_id`
  UUID PK, `slug` unique, `name`, JSONB voice fields, `is_archived` (soft delete),
  audit cols.
- API `content_tool/api/routes/personas.py` + Workers mirror:
  `GET/POST /personas`, `GET/PUT /personas/{slug}`, `/archive`, `/restore`,
  `/usage`. **No duplicate endpoint. No last-voice guard.**
- Web: `/web/app/voices/page.tsx` + `web/components/voices/*`
  (`Rolodex`, `ComposeDrawer`, `CopyToVoiceDialog`, ...). `/web/app/prompts/page.tsx`
  + `web/components/SourcePolicyEditor.tsx`.

## Target design

### Data model

**Voice key:** use the persona **`slug`** (text) as the scoping key everywhere.
A reserved sentinel **`__shared__`** denotes global/shared rows (judges, and the
canonical seed set). No hard FK to `personas(slug)` because of the sentinel and
because personas are archive-only (never hard-deleted), so orphaning is not a
risk; an index on `voice_slug` suffices.

**`prompt_templates`** (migration):
- Add `voice_slug TEXT NOT NULL DEFAULT '__shared__'`.
- New composite **PK `(voice_slug, template_id)`**.
- Judges keep `voice_slug='__shared__'` (global).
- Agent/partial rows are duplicated per existing voice; the canonical
  `__shared__` agent/partial set is **retained** as the seed-of-record that the
  seeder writes to and that brand-new installs start from (see Seeding).
- Index on `voice_slug`; existing `category` index retained.

**`prompt_versions`**: add `voice_slug TEXT NOT NULL DEFAULT '__shared__'`;
history/revert scoped by `(voice_slug, template_id)`.

**`source_policy`**: migrate from singleton to per-voice.
- Add `voice_slug TEXT NOT NULL`; backfill the existing `'default'` row's body
  into one row per existing voice (+ keep a `__shared__` seed row).
- New PK `voice_slug` (drop the `policy_id='default'` singleton PK).
  `policy_id` retained as a column (always `'default'`) only if needed for
  backward-compat; preferred: repurpose PK to `voice_slug`.

**`source_policy_versions`**: add `voice_slug`; scope history/revert by voice.

> **Migration ordering invariant (repeated from CLAUDE.md):** the DB migration
> must be pushed **before** the code that reads the new columns is deployed.

### Runtime loaders (both backends, kept in parity)

- `TemplateRow`/row type gains `voice_slug`.
- Cache keyed by `(voice_slug, template_id)`.
- `get_assembled(template_id, *, voice_slug, session)` — resolves includes
  **within the same voice** (a voice's agent prompt includes that same voice's
  partials). Judges resolve against `__shared__`.
- `get_assembled_standalone(template_id, *, voice_slug)` — `topic_*` agents pass
  the batch voice (`batch.persona_default`, default `bowtie-editor`).
- Fallback chain when a voice is missing a template row: **fall back to
  `__shared__`** then to the bundled file (keeps the app booting if a voice was
  created before a new template was added to the canonical set).
- `source_policy_store`: `snapshot(voice_slug, session)` /
  `get_policy(voice_slug, session)`; fall back `voice → __shared__ → YAML`.

### Agent call-site changes (Python)
- `writer.py`: pass `persona_name` to `get_assembled` + `get_policy`.
- `audit.py`, `outline.py` (×2: `outline`, `outline_create_mode`),
  `gap_analysis.py`: pass `run.persona`.
- `topic_gen.py`, `topic_dedup.py`, `topic_hot.py`, `topic_existing_search.py`:
  thread the batch voice through `get_assembled_standalone`.
- Workers `production.ts` / agent equivalents: mirror.

### API surface

**Prompts** — add a required-with-default `voice` param to every template
endpoint (query param `?voice=<slug>`, default `bowtie-editor`; judges ignore it
/ resolve `__shared__`):
- `GET /prompts/templates?voice=<slug>` — agent+partial for that voice + shared judges.
- `GET/PUT /prompts/templates/{id}?voice=<slug>` and `…/schema|consumers|history|versions|preview|revert`.
- Optimistic-concurrency (`expected_sha256`) unchanged, now per `(voice, id)`.

**Source policy** — add `?voice=<slug>` to all `/source-policy*` endpoints.

**Voices (personas)**:
- **New** `POST /personas/{slug}/duplicate` — body `{ slug, name }`. Atomically
  clones: persona row + that voice's agent/partial `prompt_templates` + source
  policy (and seeds initial `prompt_versions`/`source_policy_versions` rows).
  409 on duplicate target slug.
- **Guard** `POST /personas/{slug}/archive` — reject (409) if it is the last
  non-archived voice. Same guard in Workers.
- Existing `POST /personas` raw-create retained for completeness, but the UI
  routes new-voice creation through duplicate.
- Workers mirror for all of the above.

### Web UI
- **`/prompts`**: add a **voice selector** (top of page). Prompt Library lists
  the selected voice's agent+partial templates; a separate **"Shared (judges)"**
  read-only group. The **Source Policy tab is scoped to the selected voice**.
  All edit/preview/history calls pass `?voice=`.
- **`/voices`**: ComposeDrawer "create" becomes **"Duplicate voice"** (choose
  source voice + new slug/name) — reuse/extend `CopyToVoiceDialog`. Disable
  archive/delete control on the **last** non-archived voice (with tooltip).

## Invariants & risks
- **Sha parity** Python↔TS for both prompt assembly and source-policy JSON must
  hold — per-voice changes *which row* is read, not the serializer. Parity gate
  (`deploy/cloudflare-workers/parity/check-parity.mjs`) must pass.
- **No PII/PHI** — editorial content only; unchanged.
- **Cache** is per-process and busted on save; per-voice keys multiply entries
  but the set is small.
- **Topic expansion** must resolve a concrete voice; default `bowtie-editor`
  when a batch has none.
- **Backfill correctness** — every existing voice must end with a full
  agent/partial set + a source-policy row; assert counts post-migration.

## Out of scope
- Judges becoming per-voice (explicitly global per decision).
- Free-form raw-text editing of the rendered source-policy block (structured
  JSON editor retained).
- Per-voice pricing/config.

## Phase 0 decisions (resolved 2026-06-05)
- **Seed-of-record:** keep the canonical agent/partial set under
  `voice_slug='__shared__'`. Fresh installs start from it and every voice falls
  back to it for a missing template (`voice → __shared__ → bundled file`).
- **`source_policy.policy_id`:** **dropped**. PK is repurposed to `voice_slug`
  (one policy row per voice). All code/queries referencing `policy_id='default'`
  must be updated.

## Future work (separate feature — not part of this spec)

- **Voice → CMS / publish-target mapping** (requested 2026-06-05). This feature
  establishes the **voice (persona slug) as the central scoping entity**; a
  publish-target mapping is the same additive shape. Today publishing is a
  single Bowtie WordPress target via env (`WP_TARGET`, `WP_BASE_URL`, `WP_*`)
  in `wordpress/client.py` + `publish.py`. Future intent: each voice maps to
  **which CMS/endpoint** it publishes to (multiple WordPress instances, other
  CMSes, arbitrary endpoints), selected via a **dropdown** in the voice editor.
  Proposed model: a `publish_targets` table (`id, name, kind, base_url,
  auth_ref, status`) with a CMS-agnostic `kind` discriminator, and a per-voice
  `personas.publish_target_id` (nullable FK; null → env default). Credentials
  stay **out of the DB** (`auth_ref` = secret name; real creds via env/secret
  store). To be specced/planned + migrated **on its own dated doc**, not bolted
  onto this migration.
