# Per-Voice WordPress Taxonomy Cache (Phase 1.5)

**Date:** 2026-06-08
**Status:** Spec — approved (feature branch `feat/per-voice-wp-taxonomy`)
**Author:** feature-dev (franco.ma)
**Follows:** [Per-Voice CMS Publish Targets](2026-06-09-per-voice-cms-publish-targets.md)

## Problem

Phase 1 routed each voice's **publish destination** (base URL + credentials) to
its own CMS, and a follow-up fixed the dry-publish *preview*. But the WordPress
**entity metadata** an operator selects at HITL_2 is still single-instance:

- The author/category pickers (`GET /wp-options/users`, `/wp-options/categories`)
  read DB tables `content_tool.wp_users` / `content_tool.wp_categories`, which
  have **no per-instance column** — they hold only the Bowtie WP snapshot. The
  endpoints take just `?q=`; they never learn the run's voice/target.
- `runs.ts` `existing-post`, `existing-post/refresh`, and `republish` build a
  `WordPressClient` from the **default env**, so for a non-default voice they
  read/write the wrong WP instance.

Result: a VHIS101-voiced run shows **Bowtie** authors/categories, and any id
picked is a Bowtie id that does not exist on the VHIS101 site → WP rejects or
mis-assigns it on publish (even though the destination URL is correct).

## Locked decisions

1. **Per-target cache** (not live-fetch): `wp_users` / `wp_categories` gain an
   `auth_ref` discriminator; the sync populates one snapshot per target; the
   pickers filter by the run's resolved `auth_ref`.
2. **Discriminator = `auth_ref`** (the env-prefix string from `publish_targets`,
   e.g. `WP`, `VHIS101_WP`), NOT `publish_target_id`. Reasons: the sync resolves
   creds by `auth_ref`; the default/legacy voice has no target row but resolves
   to `auth_ref='WP'`; keeps the cache decoupled from target-row lifecycle.
3. **Default = `'WP'`**: existing rows backfill to `'WP'`; a NULL/unassigned
   voice resolves to `'WP'` — byte-identical behaviour to today for Bowtie.
4. **Sync stays Python-only** (`scripts/sync_wp_taxonomy.py`, nightly cron). It
   iterates active `publish_targets` + the implicit default `WP`, building a
   client per target via `wp_factory.build_target_client`. A missing-cred or
   WAF failure on one target logs + skips; other targets still sync.
5. **Pickers learn the target via `?run_id=`**: the endpoint resolves
   `run.persona → publish_target → auth_ref`. No run_id → `'WP'` (back-compat).

## Design

### Migration (`20260611000000_wp_cache_per_target.sql`)
- `ALTER TABLE wp_users  ADD COLUMN auth_ref varchar NOT NULL DEFAULT 'WP';`
  (same for `wp_categories`).
- Replace single-column `id` uniqueness with composite **`(auth_ref, id)`**
  (drop the old PK if present; the same WP id can recur across instances). Drop
  the `id` sequence default — WP supplies ids; the sync inserts them verbatim.
- Backfill is implicit via the column DEFAULT (existing rows → `'WP'`).
- Safe to push before code: the new column defaults to `'WP'`, and current
  reads (no `auth_ref` filter) still return the Bowtie rows.

### Sync (`scripts/sync_wp_taxonomy.py`)
- Load active targets from `publish_targets` (+ a synthetic default `WP` from
  the legacy `WP_*` env). For each: resolve creds by `auth_ref`, fetch
  `list_users()` + `list_categories()`, then **per-`auth_ref`**
  `DELETE WHERE auth_ref = :ref` + insert with `auth_ref`. One target's failure
  is logged and skipped (exit code reflects partial failure: 2 = at least one
  upstream WP failed).

### Read layer (both backends)
- `db/wp.ts` `queryWpUsers` / `queryWpCategories` gain an `authRef: string`
  param → `WHERE auth_ref = ${authRef}` AND the existing id/name filter.
- Python equivalent (`api/wp_options_cache.py` / its query) mirrors this.

### Endpoints (both backends)
- `GET /wp-options/users|categories` accept optional `?run_id=`. Resolve
  `run.persona → resolve target → auth_ref` (reuse `resolvePublishTarget` /
  `resolve_wp_target`); pass to the query. No run_id → `'WP'`.

### Web
- The HITL_2 author/category picker fetches include the current `run_id`
  (`/wp-options/users?run_id=…&q=…`).

### existing-post / refresh / republish (`runs.ts`)
- Build the `WordPressClient` from `buildTargetEnv(resolvePublishTarget(...))`
  so refresh prefill + republish hit the voice's WP. (Python `routes/runs.py`
  already resolves per-voice for dry-publish; align these paths too.)

## Migration of in-flight data
Existing runs that already stored Bowtie author/category ids for a non-default
voice are NOT auto-corrected. After deploy + a VHIS101 sync, the operator must
re-pick author/category from the corrected lists (clear the stale ids). Called
out in the PR description; no data backfill in scope.

## Risks / edge cases
- **Composite PK**: confirm the live tables' current PK before the migration
  (baseline shows `id` + a sequence; verify the actual constraint name).
- **Sync partial failure**: VHIS101's WAF may block the backend IP (same as
  Bowtie). Sync must not abort all targets if one fails.
- **run_id on a create run with no target**: resolves to `'WP'` — correct.
- **Parity**: `/wp-options/*` shapes must stay identical PY↔TS; deploy migration
  first, then both backends.

## Build order
0. Spec (this) + branch. 1. Migration. 2. ORM model (`auth_ref` on the two
   cache models, both backends' schema types). 3. Sync rewrite + tests.
4. Read layer (`db/wp.ts` + Python) + tests. 5. Endpoints (`run_id` →
   `auth_ref`) both backends + tests. 6. Web picker passes `run_id`.
7. existing-post / refresh / republish target-aware. 8. Full test + parity +
   tsc/ruff/pyright. 9. Push migration, deploy both backends, run VHIS101 sync.

## Test plan
- Unit (PY+TS): query filters by `auth_ref`; endpoint run_id→auth_ref dispatch
  (null/default/VHIS101); sync per-target delete+insert + skip-on-failure.
- Integration (PY): wp_options round-trip per auth_ref.
- Parity: `/wp-options/users|categories?run_id=` identical across backends.

## Out of scope
Live (non-cached) option fetch; auto-correcting historical runs' stale ids;
Ghost taxonomy (Ghost MVP has no categories/authors in scope).
