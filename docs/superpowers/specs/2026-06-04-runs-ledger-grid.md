# Runs Ledger — operations grid for managing runs & topic batches

- **Date:** 2026-06-04
- **Status:** Design validated via interactive demo (4 rounds) → plan written.
- **Plan:** [`plans/2026-06-04-runs-ledger-board.md`](../plans/2026-06-04-runs-ledger-board.md)
- **Visual source of truth:** [`2026-06-04-runs-ledger-demo.html`](./2026-06-04-runs-ledger-demo.html). The
  demo evolved this spec: flat sortable table → **grouped board** (4 status groups); topic batches →
  **full-width tinted band** with nested promoted runs; run-expand → **draft + destination preview**
  (debug log removed); rich identity column with **source link for rewrites**; sticky headers. See the
  plan for the reconciled, build-ready design.
- **Surface:** `web/` (Next.js 16) + new lightweight WP-meta endpoints on both backends
- **Related:** `app/page.tsx` ("The Desk"), `lib/desk-items.ts`, `components/desk/DeskRow.tsx`,
  `2026-06-01-run-editor-shared-components.md`, `2026-06-01-multi-user-resilience-and-roles-design.md`

## 1. Problem

The front page (`/`) is **"The Desk"** — a triage view that groups runs + topic batches into three
editorial lanes (On your desk → In motion → Filed) as large list rows. It answers *"what needs me?"*
well but not *"show me the whole book of work, sortable and filterable, and let me act on many at
once."* Operators running dozens of concurrent rewrites / new-articles / topic-batches want a dense,
columnar **ledger** (Google Sheets / Monday.com) with inputs, WordPress destination, status, and
actions in one scannable row — plus bulk operations and per-row debug logs.

## 2. Direction

A dense, quiet, scannable **broadsheet ledger / wire-service log** — not a marketing dashboard.
Stays inside the existing editorial system (paper `#F8F5EE`, ink, hairline `rule`, single rust accent
`#B0331E`; Fraunces / IBM Plex / Noto TC; newsprint grain; 2px radius). **Status is the only
colour-coded signal**; everything else is monochrome.

**Memorable detail — "The Ledger":** column groups divided by *double hairline rules* under small-caps
kicker headers (`BRIEF · WORDPRESS · STATE`), `tabular-nums` throughout, a **rust left-spine** on rows
that need the operator, and a row that **expands like a paper insert** to reveal the debug log.

The Ledger is a *second lens* over the same `buildDeskItems(runs, batches)` data — not a parallel
system. It reuses the existing gate-action model wholesale.

## 3. Decisions (locked 2026-06-04)

| # | Decision | Choice |
|---|---|---|
| D1 | Placement | **Separate route + nav link.** Repurpose the `/runs` redirect stub into the Ledger page; add a "Ledger" entry to the masthead nav. `/` stays the Desk. |
| D2 | Inline cell editing | **A few low-risk inline edits:** `wp_publish_status`, `persona` (voice), `wp_author_id`, `wp_category_ids` via in-cell dropdowns. Everything else opens the run. |
| D3 | Bulk actions | **Delete, Restart failed, Approve outline (HITL_1), Publish, Republish, Assign author, Assign category** (and similar low-risk metadata assignment). |

> ⚠️ **Bulk publish-live is destructive and hard to undo.** Per org + existing `approve_publish`
> behaviour, bulk Publish/Republish that targets `wp_publish_status === "publish"` MUST use an
> explicit count-confirmation dialog ("Publish N posts live"), never a single click.

## 4. Layout

### 4.1 Route & nav (D1)
- `web/app/runs/page.tsx` — currently `redirect("/")`; becomes the Ledger grid page.
- `components/Masthead.tsx` `NAV` — add `{ href: "/runs", label: "Ledger" }` (keep `/` = "Runs"/Desk).
- Shared tab + filter state lives in the URL query (`?tab=&status=&q=…`) so Desk ↔ Ledger links round-trip.

### 4.2 Tabs (unchanged taxonomy — from `TABS`)
`All` · `Rewrites ↻` · `New articles ✦` · `Topic batches ❉`, each with the existing total + "needs you"
badge counts (`counts.totals` / `counts.desk`).

### 4.3 Heterogeneous columns
Runs and topic batches have different fields, so column sets are per-tab (Monday-style per-group columns):
- **Rewrites / New articles / Topic batches** → full type-specific column set.
- **All** → common core (Title, Type, Status, Owner, Created, Action); row-expand reveals type detail.

### 4.4 Columns — runs (grouped)

| Group | Column | Field(s) | Editable inline (D2) |
|---|---|---|---|
| — | **Topic** (frozen, links to run) | `topic` | no |
| BRIEF | Type | `start_mode` / `chosen_route` + `AUTO HITL_1` | no |
| BRIEF | Source / Audience | `article_url` (rewrite) / `target_audience` (create) | no |
| BRIEF | Voice | `persona` | **yes — persona dropdown** |
| BRIEF | Mode | `mode` | no |
| BRIEF | Keywords | `keywords[]` (chips, `+N`) | no |
| BRIEF | Adv / Widget | `acf_adv_id` / `acf_widget_id` | no |
| WORDPRESS | Publish status | `wp_publish_status` | **yes — draft/scheduled/live** |
| WORDPRESS | Author | `wp_author_id` → `listWpUsers()` | **yes — author dropdown** |
| WORDPRESS | Categories | `wp_category_ids` → `listWpCategories()` | **yes — multi-select** |
| WORDPRESS | Slug | `wp_slug` | no |
| WORDPRESS | WP post | `wp_pushed_post_id` (↗ live link) | no |
| STATE | Status | `status` → `RunStatusBadge` | no (the one colour) |
| STATE | Iter | `iteration_count` / `hitl_2_iteration` | no |
| STATE | Age | `created_at` (ledger date) | no |
| — | **Action** | `gate` (from `desk-items`) | inline gate buttons |
| — | ⋯ overflow | | Open · Open HITL · Restart · Delete · Open WP post · Copy ID |

Overflow-only / expand-only fields: `edit_note`, `wp_excerpt`, `wp_tag_ids`, `wp_featured_media_id`,
`error.message`.

### 4.5 Columns — topic batches
Theme (`research_theme`, frozen) · Audience · Topics (`topic_count` + promoted) · KW/topic
(`keywords_per_topic`) · Defaults (`persona_default`, adv/widget, `auto_accept_hitl1_default`) ·
Cost (`cost_cents`) · Status (`BATCH_META` chip) · Created/by · Action (`Review topics` /
`Finish promotion` / `Inspect`). Promotion stays per-candidate on the batch detail page.

### 4.6 Row expand → debug log
Chevron on the frozen cell opens a full-width insert:
1. `<DebugLogPanel streamId streamKind={"run"|"batch"} />` — persisted per-step log + download (existing).
2. Overflow brief fields + WP payload preview (`useWpPayloadPreview` / `dryPublish`).

### 4.7 Grid affordances
- Sticky header + frozen first column.
- Sort by group-aware headers (Age, Status, Cost, Topic); rust caret = active sort.
- Quick-filter rail ("dateline" bar): search (topic/URL), status multiselect, persona, mode, **"Needs me"** toggle.
- Column-group show/hide (collapse wide WORDPRESS group); persisted to `localStorage`.
- Density toggle (compact 36px / comfortable).
- Default sort = lane priority (desk → motion → filed) to retain triage value.
- **Responsive:** below `lg`, degrade to stacked cards (reuse `DeskRow`).

### 4.8 Bulk actions (D3)
Checkbox select → action bar. Each respects `useRole()` capability gating.

| Bulk action | Mechanism | Guard |
|---|---|---|
| Delete | `api.deleteRun` / `topicBatchesApi.delete` fan-out | admin; confirm dialog |
| Restart failed | `api.restartRun` fan-out (failed rows only) | `create_run` |
| Approve outline | `api.resumeHitl1` fan-out (hitl_1 rows only) | `hitl1_approve` |
| Publish | `api.resumeHitl2(approve)` fan-out (hitl_2 rows only) | `publish`; **count-confirm if any target is live** |
| Republish | `api.republish` fan-out (persisted/published rows) | `publish`; count-confirm |
| Assign author | new `PATCH wp-meta` bulk (see §5) | `editor` |
| Assign category | new `PATCH wp-meta` bulk (see §5) | `editor` |

Selection is filtered to eligible rows per action (e.g. "Approve outline" ignores non-`hitl_1` rows and
reports the skipped count — no silent truncation). Fan-out runs sequentially with per-row success/error
toasts and a summary.

## 5. Backend work (required — not frontend-only)

Inline + bulk **author / category / publish-status** assignment (D2, D3) cannot reuse `PUT /{run_id}/article`
because that endpoint **requires** `html_body` + `seo_title` + `meta_description`. New lightweight endpoints
are needed on **both** backends (Python `content_tool/api/routes/runs.py` *and* Workers
`deploy/cloudflare-workers/src/routes/runs.ts`), kept parity-equivalent:

- `PATCH /runs/{run_id}/wp-meta` — partial update of `wp_*` fields only (optimistic `expected_version`
  on the Render row, mirroring the existing 409 `stale_version` contract). Writes WP fields onto the Run
  row exactly like the article PUT's `wp_values` block.
- `POST /runs/wp-meta:bulk` *(or* client fan-out of the single PATCH*)* — assign one author/category set
  across many runs. Start with **client-side fan-out of the single PATCH** (KISS / YAGNI); add a true
  bulk endpoint only if latency demands it.

Publish / republish bulk = client fan-out of existing `resumeHitl2` / `republish` — **no new endpoint**.

Parity gate: `node deploy/cloudflare-workers/parity/check-parity.mjs` must stay green.

## 6. Reuse / new files

**Reused as-is:** `RunStatusBadge`, `PaperStamp`, `DebugLogPanel`, `useDeskActions`, `hitl2Body`,
`RoleButton`/`RoleGate`, `useRole`, `desk-items.ts` (`buildDeskItems`/`filterByTab`/`TABS`/gate model),
`api.listRuns` + `topicBatchesApi.list`, `listWpUsers`/`listWpCategories`, shadcn `tabs`/`dialog`/
`dropdown-menu`/`select`/`sheet`/`badge`.

**New (web):**
- `lib/runs-grid/columns.ts` — per-tab column defs (pure, unit-tested like `desk-items.ts`).
- `lib/runs-grid/use-grid-state.ts` — sort/filter/density/column-visibility (URL + localStorage).
- `lib/runs-grid/use-bulk-actions.ts` — eligible-row filtering + sequential fan-out + summary.
- `lib/useWpMeta.ts` — inline/bulk WP-meta mutation (calls new PATCH).
- `components/grid/RunsGrid.tsx` — table shell (sticky header, frozen col).
- `components/grid/GridRow.tsx` — record + gate actions + inline-edit cells + expand.
- `components/grid/GridFilterRail.tsx` — search/filter/columns/density bar.
- `components/grid/BulkActionBar.tsx` — selection action bar + confirm dialogs.

**New (backend):** `PATCH /runs/{id}/wp-meta` on Python + Workers (+ tests + parity).

## 7. Delivery plan (phased)

1. **Read-only grid** — route, nav, tabs, columns, sort/filter, row-expand debug log, responsive fallback. (No backend.)
2. **Inline edits (D2)** — new `PATCH wp-meta` (both backends, TDD + parity); persona + publish-status + author + category dropdowns with optimistic update + 409 handling.
3. **Bulk actions (D3)** — selection, eligible-row filtering, fan-out, confirm dialogs (count-confirm for live publish/republish), role gating.
4. **Polish** — density/column persistence, keyboard nav (j/k/x/enter/e), a11y audit (WCAG AA), Vitest + Playwright.

## 8. Risks / open points

- **Bulk publish-live** is the highest-risk surface — mandatory count-confirmation; consider an org audit-log line per published post (compliance already logs single publishes).
- **Inline persona change on an in-flight run** has no existing endpoint and questionable semantics mid-pipeline; scope inline persona edits to runs not yet past `production`, or drop persona from D2 if it proves unsafe. (Confirm during Phase 2.)
- **Parity drift** between Python and Workers for the new PATCH — covered by the parity gate.
- Pyright strict + ruff: new endpoints add precise types; no new errors in touched files.
