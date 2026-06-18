# Ghost ↔ WordPress parity — follow-ups (handoff)

**Date:** 2026-06-18 · **Branch:** `feat/ghost-publisher` (unmerged) · **Scope:** public marketing/editorial content only.

This doc is a session handoff. It records the **remaining** Ghost-vs-WordPress
parity gaps (findings 3–5 from the 2026-06-18 audit) that were **deliberately
deferred**, plus the context a new session needs to pick them up and to do the
prod rollout. Findings 1–2 (Ghost `fetch_article`, create idempotency gate) and
the slug/URL/JSON-LD/label/meta_title work are already DONE on this branch — see
"Already shipped" below.

---

## Status (2026-06-18 follow-up)

Findings **4 and 5 are now implemented** on this branch; finding **3 is closed as
informational** (no code change — see below). Shared validator:
`deploy/cloudflare-workers/src/util/publish_guards.ts` (`checkPublishGuards`),
wired into the HITL_2 approve path (422 before the gate is claimed) and the
dry-publish preview (`validation_error` field, surfaced in `WpPayloadView`).
Backend 729 + web 647 vitest green; tsc/eslint clean.

---

## Remaining gaps (deferred — need a decision before building)

### 3. Python backend (`content_tool/`) has zero Ghost support — CLOSED (informational, no code)
- **Resolution (2026-06-18):** verified the eval suite (`evals/runner.py`,
  `evals/run_prompt_advisor.py`, `evals/run_judges_adhoc.py`) **never publishes** —
  it judges *draft-bearing* runs (HITL_2 onward) and never calls
  `resolve_wp_target()` or any publish path. So there is no "Ghost publish path"
  for evals to exercise, and a Ghost-target voice's **draft text is still worth
  judging** (the article body is CMS-agnostic). Adding a Ghost skip filter would
  only *reduce* eval coverage for zero benefit, so it was deliberately **not**
  added. The WordPress-only constraint lives where it belongs:
  `wp_factory.build_target_client()` raises `ValueError` for any non-wordpress
  kind, and `tests/unit/test_publish_target_factory.py` asserts it. No further
  action unless Ghost becomes a primary *publish* target for the Python backend.

<details><summary>Original note (kept for context)</summary>

#### Python backend (`content_tool/`) has zero Ghost support — by design, but note it
- **Severity:** by-design / informational.
- **Where:** `content_tool/publishers/wp_factory.py` — `_SUPPORTED_KINDS = frozenset({"wordpress"})`; `build_target_client()` raises `ValueError` for any non-wordpress kind. No Ghost client exists in Python.
- **Why it matters:** Ghost is **Workers-TS-only**. Production hosting is the TS Worker (`deploy/cloudflare-workers/`), so this does not affect prod publishing. BUT:
  - The `evals/` suite + local dev run on the Python backend → **evals cannot exercise the Ghost publish path**. Any eval that publishes assumes WordPress.
  - The parity gate (`deploy/cloudflare-workers/parity/check-parity.mjs`) only diffs **read-only routes**, so it won't catch Ghost publish divergence either.
- **Options:** (a) accept TS-only and add a one-line guard/skip in evals for Ghost-target voices; (b) port a minimal `GhostPublisher` to Python for eval coverage (larger). Recommendation: (a) unless Ghost becomes a primary eval target.

</details>

### 4. `wp_category_ids` accepted but silently ignored for Ghost runs — RESOLVED (2026-06-18)
- **Severity:** LOW (web already mitigated the visible part).
- **Was:** the HITL_2 body schema (`runs.schemas.ts` `hitl2Schema`) accepts `wp_category_ids` for any kind; `GhostPublisher.postBody()` never reads them (Ghost has tags only), so they were silently dropped.
- **Fix:** `checkPublishGuards` rejects a Ghost target carrying non-empty `wp_category_ids` — **422 at HITL_2 approve** (before the gate is claimed) and a non-fatal `validation_error` in the **dry-publish preview** (so the operator sees it pre-approve). The web Category picker stays hidden for Ghost, so this only fires on a hand-crafted API call — the contract is now self-documenting instead of silently dropping data. Covered by `publish_guards.test.ts` + `runs_dry_publish_target.test.ts` + `runs_validation.test.ts`.

### 5. No guard that a `status=future` (scheduled) run carries a publish date — RESOLVED (2026-06-18)
- **Severity:** LOW → now a friendly pre-flight check for **both** CMSes.
- **Was:** `publishToGhost()` passes `publishedAt: hitl2.wp_publish_at`; Ghost's Admin API rejects `status=scheduled` with no `published_at` (422), and WordPress likewise needs a `date` for a future post. A missing date surfaced as a raw CMS 4xx mid-publish.
- **Fix:** `checkPublishGuards` requires a non-empty `wp_publish_at` whenever the chosen status is `future`/`scheduled` (kind-independent) — **422 at HITL_2 approve** and a `validation_error` in the **dry-publish preview**. Tested across both kinds.

> N/A by design (no work needed): `canonical_url`, post `template`, post-vs-page type — Ghost Admin API has no equivalents and the tool only publishes posts.

---

## Already shipped on this branch (context)

| Item | Commit | Notes |
|---|---|---|
| Ghost `fetch_article` (refresh reads the real Ghost post by slug) | `69854dc` | `GhostPublisher.fetchPostBySlug` + `fetched_articles.cms_post_id` (migration `20260618030000`) + `loadFetchedGhostPostId`. Falls back to live scrape when slug unresolved. |
| Ghost create idempotency gate | `69854dc` | On POST failure with a known slug, one slug read-back returns the already-created post (mirrors WP `gateCreateRetry`). |
| Slug change on rewrite → create NEW article (both CMS) | `963de82` | `resolvePostIdForSlug` (`src/util/url_slug.ts`): existing post + changed slug ⇒ null post id ⇒ create. |
| Always pull published URL → `article_url` (both CMS) | `963de82` | Unified create/refresh UPDATE; `/runs/{id}` renders it under the h1. |
| Remove `meta_title` for Ghost (publish + dry-publish) | `7de25e3`, `963de82`, `5b52d72` | Ghost falls back to post title. |
| FAQ JSON-LD via `codeinjection_head` (publish + dry-publish preview) | `7de25e3`, `5b52d72` | `buildGhostSchemaHead` (exported from `ghost.ts`). **Live-verified read-only** via dry-publish on run `5d474bbb`: preview now has `codeinjection_head` with `FAQPage` and no `meta_title`. |
| CMS-kind-aware labels (`/edit`, `/hitl2`, payload view) | `7de25e3` | `web/lib/cms-kind-helpers.ts` + `useRunCmsKind`. |
| Ghost metadata in snapshots/version-history + drawer | `7de25e3` | migration `20260618020000` (hitl2_snapshots ghost cols). |
| Pre-flight publish guards (findings 4 & 5) | _this follow-up_ | `checkPublishGuards` (`src/util/publish_guards.ts`): scheduled-without-date (both CMS) + categories-on-Ghost → 422 at HITL_2 approve (gate not claimed) + `validation_error` in dry-publish preview, surfaced in `WpPayloadView`. No migration. |

**Dev deploy state (2026-06-18):** backend `cf6f0010` (`bowtie-content-tool-poc-dev`), web `cdb45485` (`bowtie-content-tool-web-dev`). All dev migrations applied. The
pre-flight guards above are **code-only (no new migration)** and not yet redeployed to dev.

---

## What is NOT yet live-verified (and why)

- **URL pull-back end-to-end** (`article_url = result.link` after a real refresh): needs an actual publish; covered by unit/route tests + the SQL change. Couldn't be eyeballed without writing to the shared/prod CMS.
- **Slug-change PUT→POST flip on an already-Ghost-published run:** run `5d474bbb` has `cms_post_id=null` (its historical publish was WordPress, `wp_pushed_post_id=110416`), so it always previews POST. The flip is covered by dry-publish route tests (PUT when slug matches, POST when it differs).
- **JSON-LD rendered in the live `<head>`:** drafts aren't publicly fetchable and there are no local Ghost Admin creds (Worker-secret only), so it can't be cleaned up if published. Verified instead via the server-side dry-publish payload (above) + unit tests. A true public-head eyeball would require a **live public publish to prod healthycheckhk** → explicit go-ahead required.

---

## Prod rollout — DONE (2026-06-18, code + schema)

Branch merged + deployed to prod. WordPress unaffected; Ghost path stays dormant
until the **owner steps** below are completed.

1. ✅ **Migrations (split-migration rule — additive cols before code):** all 4 pushed to prod via `supabase db push`:
   - `20260618000000_publish_targets_ghost.sql` (kind IN wordpress|ghost; CMS-agnostic post id)
   - `20260618010000_runs_ghost_meta.sql`
   - `20260618020000_hitl2_snapshots_ghost_meta.sql`
   - `20260618030000_fetched_articles_cms_post_id.sql`
2. ✅ **Merged** PR [#16](https://github.com/bowtie-ins/ai_content_workflow/pull/16) (squash → `main` commit `7b938f6`). CI green. Deploy fires from the **fmcuni** fork only (`deploy-workers.yml` `if: repository_owner == 'fmcuni'`; bowtie-ins mirror has no `CLOUDFLARE_*` secrets → its run skips). fmcuni run `27737069717` = success, both Workers. Prod smoke: backend `/health` 200, `/runs` 401, web `/` 307.

### OWED (owner — Ghost activation; not blocking, WordPress unaffected)
3. **Prod secrets:** set `HCHK_GT_API_URL` + `HCHK_GT_ADMIN_API_KEY` on the prod backend Worker (`bowtie-content-tool-poc`) via `wrangler secret put` — **Admin key (id:secret), not a Content key**. _(Confirmed NOT present on prod as of 2026-06-18.)_
4. **Prod publish target row:** create the `content_tool.publish_targets` Ghost row (kind=`ghost`, auth_ref=`HCHK_GT`) on prod and point the intended voice's `personas.publish_target_id` at it — via prod `/settings/publish-targets` (claude-debug is DEV-ONLY → the user does this).
5. **Live publish verification:** any real Ghost publish hits **production healthycheckhk** (shared/prod). Needs explicit go-ahead; prefer status=draft first, then read back via the Ghost Admin dashboard. Covers the not-yet-live-verified items above (URL pull-back, slug PUT→POST flip, JSON-LD in public `<head>`).
