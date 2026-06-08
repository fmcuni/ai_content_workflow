# Per-Voice CMS Publish Targets

**Date:** 2026-06-09
**Status:** Spec — pending approval
**Author:** feature-dev (franco.ma)

## Problem

Today the app publishes every article to a single hard-wired WordPress target,
built once at graph startup from `WP_BASE_URL` / `WP_USERNAME` / `WP_APP_PASSWORD`
env vars. There is no way to give different **voices** (personas) different CMS
destinations. We want each voice to map to its own CMS — multiple WordPress
instances plus Ghost(Pro) — picked via a dropdown in the voice editor.

## Locked decisions (aligned with user 2026-06-09)

1. **Config/creds model:** New `publish_targets` DB table holds non-secret config
   only (`name`, `kind`, `base_url`, `auth_ref`, `status`). Real credentials stay
   in `.env.local` / `wrangler secret`, looked up by `auth_ref`.
2. **Auth-ref convention:** `auth_ref` is an env-var prefix.
   - `wordpress` → `{ref}_USERNAME`, `{ref}_APP_PASSWORD` (base_url from DB row)
   - `ghost` → `{ref}_ADMIN_API_KEY` (base_url from DB row)
3. **Binding:** `personas.publish_target_id` nullable FK → `publish_targets`.
   `NULL` falls back to the legacy WP env. Dropdown in the voice ComposeDrawer.
4. **Ghost scope (MVP):** Ghost Admin API `/posts` with `?source=html`:
   title, html, slug, custom_excerpt, tags, feature_image, status (draft/published).
   JWT (HS256) signed from the Admin API key `id:secret`. No SEO meta / categories /
   authors in MVP (silently ignored).
5. **Cardinality:** Exactly one target per voice; per-run override retained.
6. **Backward compat:** Seed the existing Bowtie WP env as a `publish_targets`
   row "Bowtie WordPress" (`auth_ref='WP'` → existing `WP_*` vars). Assign the
   `bowtie-editor` voice to it. Zero behavior change for existing runs; `NULL`
   FKs also resolve to the legacy fallback.

## Design

### Publisher abstraction
A kind-agnostic `Publisher` (Python `Protocol` / TS `interface`) with a single
`upsert(PublishRequest) -> PublishResponse`. Two implementations:
- `WordPressPublisher` — thin adapter over the existing `WordPressClient` (no logic change).
- `GhostPublisher` — new; JWT auth + Ghost Admin API create/update.

A stateless **factory** `resolve_publisher(session, target_id)` loads the target
row, resolves creds from env via `auth_ref`, and returns the right Publisher.
`target_id=None` → legacy WP env fallback. Archived target → raise.

### DB migration (`20260609000000_publish_targets.sql`)
- `content_tool.publish_targets` table + `kind` CHECK + RLS (USING(true), same as
  personas) + grants to `content_tool_app`.
- `personas.publish_target_id` nullable FK, `ON DELETE SET NULL`.
- Seed "Bowtie WordPress" row (stable UUID) + assign `bowtie-editor` voice.
- Safe to push before code ships (nullable column, unused until code reads it).

### Resolution flow
`persona.publish_target_id` (or per-run override) → load target row → resolve
creds by `auth_ref` → build Publisher → `upsert()`. Slots into
`graph/root.py::n_publish_or_revise` (Python, factory called per-run, global
`wp_client` removed) and the `production.ts` publish gate (Workers).

### Web
- Dropdown in `web/components/voices/ComposeDrawer.tsx` (Default / target list).
- New `/settings/publish-targets` admin list + `TargetDrawer` (CRUD), mirroring
  the prompts/source-policy admin pattern.
- CRUD API routes in both backends (`requireRole('admin')` on mutations).

### Ghost details
- JWT: HS256, header `{alg, kid:id}`, claims `{iat, exp:iat+300, aud:'/admin/'}`,
  signed with `bytes.fromhex(secret)`. TS uses Web Crypto (no new dependency).
- Create: `POST {base}/ghost/api/admin/posts/?source=html`.
- Update: GET current `updated_at`, then `PUT .../posts/{id}/?source=html` with
  `updated_at` for optimistic concurrency; 409 → `GhostConflictError`.

## Risks / edge cases
- Missing/invalid creds → factory raises → run fails with clear error. (Phase 2:
  a `verify` dry-run endpoint.)
- Archived target referenced by a voice → factory raises; web warns with the
  count of assigned voices before archiving.
- **Ghost post id is a uuid string**, not the integer `wp_pushed_post_id`. MVP:
  store Ghost `link` in `runs.article_url`; re-publish re-derives the id via
  slug/URL lookup. Follow-on migration adds `runs.cms_post_id text`.
- `duplicate_persona` must NOT copy `publish_target_id` (clone starts unassigned).
- Parity gate: deploy migration first, then ship both backends atomically.

## Build order
0. Migration (+ this spec). 1. ORM/schema types + `publish_target_id` on persona.
2. Publisher base/types. 3. WordPress adapter. 4. Ghost publisher (TDD: JWT test
first). 5. Factory. 6. Wire `publish.py` + `graph/root.py` + `production.ts`.
7. Dry-publish `target_label` from DB. 8. CRUD routes + register. 9. Web dropdown
+ admin page. 10. Tests (unit + integration + parity). 11. Push migration to
prod, deploy both Workers + restart Python.

## Test plan
- Unit (PY + TS): factory dispatch (null/WP/Ghost/archived/missing-env), Ghost JWT
  structure, Ghost create vs update vs 409.
- Integration (PY): publish_targets CRUD, persona `publish_target_id` round-trip.
- Parity: `GET /publish-targets` + `GET /personas` shapes identical across backends.

## Out of scope (MVP)
Fan-out to multiple targets; Ghost SEO meta / authors / categories / featured
image upload / newsletter; encrypted-creds-in-DB; cred verification endpoint.
