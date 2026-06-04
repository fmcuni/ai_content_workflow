# Plan — Runs Ledger board

- **Date:** 2026-06-04
- **Spec:** [`specs/2026-06-04-runs-ledger-grid.md`](../specs/2026-06-04-runs-ledger-grid.md)
- **Visual source of truth:** [`specs/2026-06-04-runs-ledger-demo.html`](../specs/2026-06-04-runs-ledger-demo.html)
  (interactive mock, signed off through 4 feedback rounds — the build should match it)
- **Surface:** `web/` (primary) + one new partial-update endpoint on both backends.

### Plan audit decisions (2026-06-04)

1. **Voice is NOT inline-editable.** Drop persona from inline edits; the grid shows Voice read-only and
   editing voice happens on the run page. **Adv ID / Widget ID remain inline-editable** (they affect only
   re-runs/republish, not the current draft).
2. **Bulk publish-live is allowed** with a mandatory count-confirmation dialog + a per-post compliance
   log line.
3. **Topic-batch defaults ARE editable** inline in the band (voice/adv/widget defaults) — needs a new
   `PATCH /topic-batches/{id}`. Safe: a default only affects runs promoted **after** the change, never
   an already-generated draft. (Note: run-level Voice stays read-only per #1; batch *default* voice is editable.)
4. **Ship as one PR** for the whole feature; the phases below are internal build milestones, not separate PRs.

## 1. Goal

Add a dense, grouped **operations board** at `/runs` (currently a redirect to `/`) that shows every
rewrite, new article and topic batch as one record, lets operators edit destination/brief fields
inline, drill into a batch to see the articles it spawned, preview a draft without opening it, and act
on many runs at once — while keeping the existing editorial Desk (`/`) intact.

## 2. Design locked by the demo

- **Grouped board** (not a flat sortable table): 4 collapsible status groups, newest-first within each —
  **Needs your review** (`hitl_1`/`hitl_2`/`changes_requested`), **Generating**
  (`pending`/`fetching`/`strategy`/`production`), **Approved & published** (`persisted`/`published`),
  **Failed & closed** (`failed`/`rejected`/`cancelled`). Batch statuses map to the same groups.
- **Rich frozen identity column:** type chip (✦ New / ↻ Rewrite·Full|Small) + run-status badge + AUTO H1 +
  title + mono sub-line (`run id · mode · WP #post ↗`) + **source link for rewrites** (`↗ host/path`) + keyword chips.
- **Run right columns:** BRIEF — Voice (**read-only**) · Adv ID (edit) · Widget ID (edit); WORDPRESS —
  Author (edit) · Category (edit) · **Slug** (edit; decoded CJK, accepts encoded or decoded) ·
  Publish (edit) · Post date (edit).
- **Topic batch = full-width tinted band** (rust left-edge), NOT mapped to run columns: theme · audience ·
  焦點 focus · topics · progress · cost · AUTO-H1 + voice/adv/widget defaults (**editable inline**) · action.
  Expands to its **promoted runs nested + indented** (`└`), aligned to the run columns.
- **Run expand = Draft + destination preview** (no debug log): left = SEO title / meta / H2 chips /
  excerpt / "Open full draft →"; right = target, source (rewrites), slug, author, category, publish+date,
  **audit verdict + H/M/L**, cost + iterations, last touch.
- **Sticky** two-row column header + group headers (grid is a bounded scroll viewport).
- Promoted runs appear **both** nested under the batch and flat in New Articles. Children load on expand.

## 3. Grounded backend facts (verified 2026-06-04)

- `wp_publish_at` **already exists** on the run row (`db/models.py`) → no migration for Post date.
- WP-metadata edits today go only through `PUT /runs/{id}/article`, which **requires** `html_body` +
  `seo_title` + `meta_description` → a lightweight partial-update endpoint is **required** for inline/bulk
  field edits.
- Run→batch linkage: `Run.topic_candidate_id` → `TopicCandidate.promoted_run_id`. The batch **list**
  endpoint (`GET /topic-batches`) returns NO candidates; only `GET /topic-batches/{id}` includes them →
  **batch children load lazily on expand**, and `promoted_count` is not in the list payload.
- Reused existing endpoints: `listRuns`, `restartRun`, `deleteRun`, `resumeHitl1`, `resumeHitl2`,
  `republish`, `getLatestRender`, `getLatestAudit`, `getGapAnalysis`, `GET /costs/run/{id}`,
  `listWpUsers`, `listWpCategories`, `topicBatchesApi.list/get/promote/delete`.

## 4. New backend (two endpoints, both backends, parity + TDD)

`PATCH /runs/{run_id}` — partial update of editable fields only:
`acf_adv_id`, `acf_widget_id`, `wp_author_id`, `wp_category_ids`, `wp_slug`, `wp_publish_status`,
`wp_publish_at` (**not `persona`** — Voice is read-only in the board per audit decision 1). Behaviour:
- Only provided fields overwritten (mirror the `wp_values` block in `PUT /article`).
- Optimistic concurrency: accept `expected_version`, return `409 stale_version` like `PUT /article`.
- `wp_slug` accepts encoded or decoded; store canonical (decode-then-`encodeURIComponent`), so the grid
  can show decoded and WP receives encoded.
- Role: `editor`+ (server-authoritative, per `lib/roles.ts` / Workers RBAC).
- Implement on **Python** (`content_tool/api/routes/runs.py`) and **Workers**
  (`deploy/cloudflare-workers/src/routes/runs.ts`); keep the parity gate green
  (`node deploy/cloudflare-workers/parity/check-parity.mjs`).

*Optional nicety (defer unless cheap):* add `promoted_count` to the batch **list** response on both
backends so the band shows progress without expanding. Until then, show progress after expand.

**ACF caveat:** editing `acf_adv_id`/`acf_widget_id` post-hoc only affects re-runs/republish, not an
already-generated draft — surface a subtle tooltip to set that expectation. Persona/Voice is excluded from
inline edits entirely (audit decision 1) and shown read-only.

`PATCH /topic-batches/{batch_id}` — partial update of batch **defaults** only: `persona_default`,
`acf_adv_id_default`, `acf_widget_id_default` (+ `auto_accept_hitl1_default`). Edits affect only runs
promoted **after** the change, never existing drafts/runs. Role `editor`+; both backends + parity + tests.
(Candidate-level fields already have `PATCH /topic-batches/{id}/candidates/{candidate_id}`.)

## 5. Frontend architecture (reuse-first)

Reused as-is: `RunStatusBadge`, `PaperStamp`, `RoleButton`/`RoleGate`, `useRole`, `useDeskActions` +
`hitl2Body`, shadcn `dialog`/`dropdown-menu`/`select`/`input`/`switch`, `api`/`topicBatchesApi`,
editorial tokens. Status→category/lane logic extends `lib/desk-items.ts`.

New files (small, focused — mirror demo structure):
- `lib/runs-grid/groups.ts` — status→group mapping + ordering (pure, unit-tested).
- `lib/runs-grid/columns.ts` — per-tab column defs (pure, unit-tested).
- `lib/runs-grid/use-board-state.ts` — tab/search/voice/collapse/density/column-visibility (URL + localStorage).
- `lib/runs-grid/use-batch-children.ts` — lazy `topicBatchesApi.get` on expand → map `promoted_run_id`→run.
- `lib/runs-grid/use-run-patch.ts` — `PATCH /runs/{id}` mutation, optimistic + 409 handling.
- `lib/runs-grid/use-batch-patch.ts` — `PATCH /topic-batches/{id}` mutation for editable band defaults.
- `lib/runs-grid/use-bulk-actions.ts` — eligible-row filtering + sequential fan-out + summary.
- `components/grid/RunsBoard.tsx` — bounded scroll viewport, sticky header, group sections.
- `components/grid/GroupSection.tsx`, `RunRow.tsx`, `IdentityCell.tsx`, `BatchBand.tsx`,
  `RunExpand.tsx`, `InlineCells.tsx` (select/slug/date/number editors), `BulkActionBar.tsx`.
- `app/runs/page.tsx` — replace the redirect with the board; `components/Masthead.tsx` — add a "Ledger" nav entry.

## 6. Phased delivery (internal milestones — one PR for the whole feature, audit decision 4)

Phases are sequencing/checkpoints within a single PR; each should leave the tree green
(pyright/ruff/tsc/tests + parity) so the final diff is reviewable as a coherent whole.

**Phase 0 — Spec sync + scaffold.** Update the spec's layout sections to the demo-validated design; turn
`/runs` into a board shell; add nav entry. Wire `api.listRuns` + `topicBatchesApi.list` (already on `/`).

**Phase 1 — Read-only grouped board (frontend only).** `groups.ts`/`columns.ts` (+ Vitest), identity cell
with source link, status groups (sticky headers, collapsible), batch band, lazy batch-children nesting,
filter rail (search/voice/collapse-done/columns/density), responsive fallback to `DeskRow` cards.

**Phase 2 — Run-expand preview (frontend, existing endpoints).** `RunExpand` lazy-queries
`getLatestRender` + `getLatestAudit` + `GET /costs/run/{id}` (+ cached `listWpUsers`/`listWpCategories`);
draft preview + destination & checks panel.

**Phase 3 — Inline edits + endpoints (backend + frontend, TDD + parity).** `PATCH /runs/{id}` **and**
`PATCH /topic-batches/{id}` on both backends with tests + parity; `use-run-patch`/`use-batch-patch` +
inline editors (runs: author/category/publish/slug-decode/post-date/adv/widget — **no persona**, Voice
read-only; band: voice/adv/widget **defaults editable**); optimistic update + 409 toast.

**Phase 4 — Bulk actions (frontend fan-out).** Selection, eligible-row filtering, `BulkActionBar`,
confirm dialogs with **count-confirmation for any live publish/republish**, role gating. Fan-out of
`resumeHitl1`/`resumeHitl2`/`restartRun`/`deleteRun`/`republish` + `PATCH` for bulk author/category.

**Phase 5 — Polish + tests.** localStorage persistence, keyboard nav (j/k/x/enter/e), WCAG AA audit,
Vitest (groups/columns/children/patch), Playwright e2e for: group render, batch drill-down, inline edit
+ 409, bulk publish count-confirm.

## 7. Test plan

- **Unit (Vitest):** `groups` (status→group, ordering), `columns` (per-tab sets), `use-batch-children`
  (candidate→run mapping), `use-run-patch` (optimistic + 409 rollback), slug encode/decode round-trip.
- **Backend (pytest):** `PATCH /runs/{id}` — partial update, version conflict 409, role gate, slug
  normalisation; parity check vs Workers.
- **E2E (Playwright):** board groups render; expand batch → nested promoted runs; inline author edit
  persists + 409 surfaces; bulk publish raises live count-confirm; source link present on rewrites only.
- Coverage target 80%+ on new modules (per repo testing rule).

## 8. Risks / out of scope

- **Bulk publish-live** — highest risk; mandatory count-confirmation + per-post compliance log line (reuse
  the single-publish compliance writer).
- **Voice/persona** — never inline-editable (audit decision 1); read-only in the board, edit on the run page.
- **ACF post-hoc semantics** — Adv/Widget edits apply on next re-run/republish only; tooltip sets expectation.
- **Batch defaults editable** — via `PATCH /topic-batches/{id}` (audit decision 3, revised); safe because edits only affect future promotions.
- **Batches out of the grid / saved views / column reordering** — not in v1.
- Pyright strict + ruff: precise types on the new endpoint; no new errors in touched files.

## 9. Definition of done

`/runs` board matches the demo; inline edits persist via `PATCH /runs/{id}` (both backends, parity green);
bulk actions work with live-publish count-confirm; Desk (`/`) unchanged; spec updated; all checks green.
