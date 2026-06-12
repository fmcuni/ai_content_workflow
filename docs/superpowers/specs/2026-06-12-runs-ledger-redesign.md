# Runs Ledger Redesign — Spec

**Date:** 2026-06-12
**Status:** Approved by operator (design iterations complete)
**Reference artifact (SOURCE OF TRUTH for visuals + interactions):**
`design/runs-redesign/runs-redesign.html` — self-contained static demo with real
production data embedded (`design/runs-redesign/demo-data.json`).
Open it in a browser at desktop (≥1080px) and mobile (390px) widths. The
implementation MUST match this HTML's layout, hierarchy, copy, colors, and
interaction behavior, except for the deltas listed in §2.

**Plan:** `docs/superpowers/plans/2026-06-12-runs-ledger-redesign.md`

---

## 1. Goal

Replace the current `/runs` page (dense grouped ledger) with a simplified,
streamlined editor workflow:

- One dense, scannable table filtered by pipeline state.
- Click a row → bottom drawer with everything needed to decide and act
  (brief, draft preview, full CMS metadata in ONE panel) — never navigate away
  for routine review/publish work.
- Multi-select rows → bulk actions (set CMS metadata, approve & publish,
  restart failed, reject).
- Fully responsive: editors can review and quick-edit on mobile.
- **No large backend changes.** Bulk = client-side fan-out over existing
  per-run endpoints. The only backend delta is §6.1 (two extra fields on the
  list payload), mirrored in both backends.

## 2. Deltas — required changes NOT yet in the reference HTML

These were accepted after the final HTML iteration; implement them on top:

1. **Author/Category combobox options show the CMS ID with the name.**
   Display format: `<name> · <CMS_TAG>#<id>` (e.g. `了解癌症 · WP#1719`,
   `Bowtie 團隊 · WP#237`). Applies to the dropdown options AND the selected
   value shown in the input, in both the run drawer and the bulk modal.
   Widen the fields / drawer column as needed so the extra info fits without
   truncating typical names (the drawer's right column and the modal may grow;
   on mobile fields are already full-width).

2. **Real status set.** The demo data only contained
   `pending | hitl_1 | hitl_2 | published | failed | rejected`. The live
   system also has transient statuses (e.g. `publishing`, `revising`,
   `running` / in-flight states — see the existing board's status mapping,
   `web/components/RunStatusBadge.tsx` and the ledger mapping fixed in
   ae44135). Map every transient/working status into the **pending** tab
   ("in progress" group) and render its own pill with the literal status name,
   using the blue "in-progress" pill style. No run may ever be invisible
   because its status isn't mapped (regression guarded by ae44135).

## 3. Cross-page alignment notes (in scope for the plan, beyond /runs)

1. **Status display names** — storage values are unchanged; display labels are:

   | stored | display |
   |---|---|
   | `hitl_2` | **drafted** |
   | `hitl_1` | **outlined** |
   | everything else | literal status name |

   This mapping must be applied consistently on **all pages** (runs board, run
   detail, /hitl2, /edit, topics board, RunStatusBadge, dashboards). Implement
   as one shared helper (e.g. `web/lib/run-status.ts` `statusLabel()`), not
   per-page strings.

2. **Shared nav bar** — the masthead + nav in the HTML (wordmark, nav links
   Runs/Topics/Voices/Prompts/Targets/Users, "+ New run" button, date stamp)
   becomes a single shared component used by **all pages** (align the existing
   `Masthead.tsx` to this design and reuse it everywhere).

## 4. Page anatomy (match the HTML)

### 4.1 Masthead (editorial accent zone)
Cream paper background, serif small-caps wordmark "BOWTIE AI CONTENT
WORKFLOW", right-aligned date stamp, nav row with active-link rust underline,
`+ New run` (ink button) → `/runs/new`.

### 4.2 Page head
Serif `Runs` H1 + one-line subtitle. (Drop the demo-note chip in production.)

### 4.3 Toolbar (sticky)
- **Status tabs** (segmented control) with counts:
  `All · drafted · outlined · pending · failed · published · rejected`.
  Counts are totals per status across all runs (not just the visible page).
  Default landing tab = **drafted** (the queue that needs the editor).
- Search input — filters topic, SEO title, slug, keywords (client-side).
- Voice filter (`Voice — all` + one option per voice present).
- Sort: `Newest first` / `Oldest first — clear backlog`.

### 4.4 Table
Columns: `[checkbox] Topic & draft · Voice · Status · CMS destination · Created`.

**Topic & draft cell** (3 lines):
1. Topic title (semibold) + flags: `rewrite`(blue)/`new`(gray) from
   `start_mode`; `brief`(amber, title = edit_note) when `edit_note` set;
   `rev N`(gray) when `hitl_2_iteration > 0`.
2. Muted 1-line clamp: latest `seo_title` (fallback `meta_description`).
3. Mono meta line: 8-char run id (full id on hover) · `/decoded-slug` when set
   · CMS post ref in green when pushed (`WP#4175`; Ghost target ⇒ `GT#…`).

**Voice**: persona display-name badge.
**Status**: colored dot pill, display label per §3.1. Colors: drafted/outlined
amber, pending/in-progress blue, published green, failed red, rejected gray.
**CMS destination** (4 mini-lines, `K: value`): CMS target name; Author
(name or italic "unset"); Cat (names or "unset"); Pub (status pill or italic
"draft (default)", + scheduled datetime when `wp_publish_at`).
**Created**: `YYYY-MM-DD HH:MM`.

Row click opens the drawer; checkbox click never opens it. Selected row =
rust-tinted background; drawer-open row also gets a rust left bar.

### 4.5 Drawer (bottom sheet, ~440px/58vh desktop)
Slides up; rust 2px top border. Header: ↑/↓ step buttons (also `k`/`j` keys),
serif topic title, status pill, 8-char run id, close (Esc).

**Default mode (drafted / published / failed / pending / rejected) — 3 columns:**
- **Brief** (left): Voice, Kind (Rewrite/New article), Source URL (refresh
  runs), Audience, Keyword chips (6 + "+N"), Created, Last change
  (both `YYYY-MM-DD HH:MM`), Revisions (when >0), **Version history →** link
  (→ run version history), and the **Operator brief** amber callout when
  `edit_note` exists — clamped to 5 lines with Show more/less toggle.
- **Draft preview** (middle): Google-SERP-style frame (target host › blog ›
  slug, serif headline = seo_title, meta_description), links: **Open full
  editor →** (→ `/runs/:id/hitl2` for drafted, `/runs/:id` otherwise) and
  **View live post ↗** when pushed. Empty state text varies by status.
- **CMS destination** (right): label shows the run's publish target name.
  ONE form: SEO title (input), Meta description (textarea), Author
  (**search-combobox**, §2.1), Category (**search-combobox**, single select,
  §2.1), Slug, Publish status (unset/draft/publish/future), Publish date.
  All fields autosave (debounced) — see wiring §6. Dirty fields flash amber.
  Footer actions by status:
  - drafted: `Reject` (danger) · `Approve & publish` (primary)
  - failed/rejected: `Restart run`
  - published: `Republish with edits`
  - plus right-aligned hint "metadata autosaves · PATCH /runs/:id".

**Outlined mode (`hitl_1`) — replaces middle + right columns:**
- **Gap analysis** (middle, scrollable): Target query; Route (chosen_route +
  route_reason); Weak sections; Outdated points; Missing topics; FAQ gaps;
  Semantic gaps (chips); Freshness; Must add / Must update / Must remove;
  Top competing pages (top 5, links). Create-mode runs (no gap analysis) show:
  "No gap analysis — this is a new article (create mode), so the pipeline
  skipped it."
- **Outline** (right, scrollable): serif H1, then each section: `H{level}`
  mono chip + heading text + `add`/`keep` flag, muted intent line, key-point
  bullets. Footer actions: `Reject` (danger) · `Approve outline` (primary).

### 4.6 Bulk bar
Floating dark pill bottom-center, appears on selection: `N selected`,
`Set CMS metadata…`, `Approve & publish` (only when selection contains
drafted runs; acts on those only), `Restart failed` (only when selection
contains failed runs; acts on those only), `Reject`, `Clear`.

### 4.7 Bulk modal — "Set CMS metadata"
Author + Category comboboxes (§2.1), Publish status, Publish date. Blank
fields leave the run untouched. Hint: slug/SEO title/meta description stay
per-run. `Apply to selection` fans out per-run PATCHes.

### 4.8 Toasts
Bottom-right, dark; production replaces the demo's endpoint-echo line with
success/error feedback per action (bulk: aggregate "8 updated, 1 failed —
retry" with per-run error detail available).

## 5. Responsive (mobile ≤760px) — match the HTML

- Toolbar: search full-width on top; tabs horizontally scrollable; filters
  share a row. Table → card list: checkbox top-left absolute; topic block;
  voice/status/created inline chips; CMS destination summary under a dashed
  divider.
- Drawer → 92dvh sheet, columns stacked (Brief → middle → right), single
  scroll; **action buttons sticky at the bottom** (Approve & publish always
  thumb-reachable). Operator brief clamps to 5 lines (tap to expand).
- Bulk bar full-width (8px gutters), buttons wrap. Modal near-full-width,
  fields single column.
- 761–1080px: drawer drops the Brief column (2 columns); table hides the CMS
  destination column.

## 6. Data & API wiring (existing endpoints unless flagged)

| UI element / action | Endpoint (Workers, mirrored in Python) | Notes |
|---|---|---|
| Table rows | `GET /runs` | already returns wp_* destination fields, keywords, persona, edit_note, start_mode, created_at |
| Row `seo_title`/`meta_description` (line 2 + drawer preview + form prefill) | `GET /runs` **⚠ backend delta §6.1** | latest render per run |
| Tab counts | `GET /runs` (derive client-side) | acceptable at current volume (~300); revisit server-side counts later |
| Status display labels | shared `statusLabel()` helper (§3.1) | display-only; API values unchanged |
| Voice names | `GET /personas` | slug → display name |
| Publish target per run | `GET /personas` + `GET /publish-targets` | persona.publish_target_id → target; null → default Bowtie target. CMS tag: `wordpress`→`WP`, `ghost`→`GT` |
| Author/Category options | `GET /wp-options?run_id=…` (or `?persona=`) | already target-scoped (auth_ref); render `name · TAG#id` (§2.1) |
| Drawer detail (on open) | `GET /runs/:id` | for fields not in the list payload |
| Gap analysis (outlined mode) | `GET /runs/:id/gap-analysis` | payload as in demo |
| Outline (outlined mode) | `GET /runs/:id/outline` | payload `{h1, sections[]}` |
| Version history link | `/runs/:id/hitl2` (history UI) / `GET /runs/:id/hitl2-snapshots` | reuse existing version-history surface |
| CMS metadata autosave (author/category/slug/pub status/pub date) | `PATCH /runs/:id` | same fields the current board's inline cells PATCH; debounce ~600ms; reviewer role |
| SEO title / meta description autosave | `POST /runs/:id/hitl2-snapshots` | same snapshot-autosave path as /hitl2 & /edit (author role) |
| Approve & publish (drafted) | `POST /runs/:id/resume` (HITL_2 approve) | **must keep the existing dry-publish/`target_label` verification step** (`POST /runs/:id/dry-publish`) before confirming — surface target_label in the confirm dialog |
| Approve outline (outlined) | `POST /runs/:id/resume` (HITL_1 approve) | |
| Reject (either gate) | `POST /runs/:id/resume` (reject) | |
| Restart (failed/rejected) | `POST /runs/:id/restart` | author role |
| Republish (published) | `POST /runs/:id/republish` | reviewer role |
| Open full editor | `/runs/:id/hitl2` (drafted) / `/runs/:id` | unchanged pages |
| Live post link | run's `wp_link` / existing-post data | |

**Bulk semantics:** client-side fan-out over the per-run endpoints above,
bounded concurrency (~4), per-run success/error collection, aggregate toast,
failed items stay selected for retry. Role-gate buttons with the existing
`RoleGate`/capability model (resume/republish/PATCH = reviewer; restart &
snapshot autosave = author).

### 6.1 Backend delta (the ONLY one; keep it small)

Add `seo_title` and `meta_description` (from the latest render per run,
`renders ⟕ drafts` by `run_id`, newest first) to the `GET /runs` list payload.
- Workers: `deploy/cloudflare-workers/src/routes/runs.ts` list query — one
  LEFT JOIN LATERAL (or equivalent) + two fields in the mapped response.
- Python mirror: `content_tool/api/routes/runs.py` list_runs — keep parity
  (`node deploy/cloudflare-workers/parity/check-parity.mjs` must stay green).
- No migration. No new endpoints.

## 7. Design tokens

Use the `:root` CSS variables in the reference HTML verbatim (paper/cream,
ink, rust accent `#b4421f`, status colors amber/blue/green/red/gray, serif
masthead stack, sans UI stack, mono meta). Translate into Tailwind 4 theme
tokens / CSS vars consistent with the existing web app.

## 8. Keyboard & a11y

- `j`/`k` step the drawer through visible rows; `Esc` closes drawer/modal;
  checkbox select-all in header.
- Drawer is `aria-label`ed; status pills carry text (not color-only); focus
  outlines per the HTML (`rust` focus rings); combobox needs proper
  `role="combobox"`/listbox semantics + keyboard (↑/↓/Enter) on implementation.

## 9. Out of scope

- Server-side pagination/counts (current volume fine; keep `limit` param).
- New bulk endpoints (explicitly avoided).
- Ghost CMS implementation (design accommodates it: target name, `GT#` tag).
- Realtime collab on this page (unchanged elsewhere).
- Topic batches board (the demo covers runs only; Topics tab keeps its page).
