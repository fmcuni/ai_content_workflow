# Runs Ledger Redesign — Implementation Plan

**Date:** 2026-06-12
**Spec:** `docs/design/specs/2026-06-12-runs-ledger-redesign.md`
**Visual source of truth:** `design/runs-redesign/runs-redesign.html`
(open in a browser; embedded real prod data in `design/runs-redesign/demo-data.json`).
Deliver the implementation to match this HTML exactly, plus the spec §2 deltas
(combobox `name · TAG#id` display; full live status mapping).

**Constraints recap:** no large backend changes — the only backend work is the
list-payload delta (spec §6.1), mirrored in both backends with parity green.
Develop and verify on the **dev** Workers stack first (per repo convention),
then promote to prod.

---

## Phase 0 — Orientation (new session pick-up)

1. Read the spec, then open `design/runs-redesign/runs-redesign.html` at
   1440px and 390px; click through: tabs, search, a drafted row (drawer +
   form), an outlined row (gap/outline mode — use the 大豆 run for a real gap
   analysis), multi-select → bulk bar → "Set CMS metadata" modal.
2. Read `web/AGENTS.md` (Next.js 16 caveats) before touching web code.
3. Existing code to reuse / replace lives in: `web/app/runs/page.tsx`
   (page being replaced), `web/components/grid/*` + `web/components/desk/*`
   (old board — superseded), `web/components/Masthead.tsx`,
   `web/components/RunStatusBadge.tsx`, `web/components/SearchableSelect.tsx`,
   `web/lib/api.ts`, `web/lib/roles.ts`, run-editor hooks under
   `web/lib/run-editor/`.

## Phase 1 — Backend delta (small, both backends)

1. Workers `deploy/cloudflare-workers/src/routes/runs.ts` `GET /` list query:
   join latest render per run (`renders` ⟕ `drafts` on `run_id`, newest
   first) → add `seo_title`, `meta_description` to the response mapping.
2. Mirror in Python `content_tool/api/routes/runs.py` `list_runs`.
3. Tests: one Workers Vitest route test + Python test; run the parity gate
   (`node deploy/cloudflare-workers/parity/check-parity.mjs`).

## Phase 2 — Shared foundations (cross-page alignment items)

1. **`web/lib/run-status.ts`**: `statusLabel(status)` → `hitl_2→"drafted"`,
   `hitl_1→"outlined"`, else literal; plus pill color class mapping covering
   ALL live statuses (transient `publishing`/`revising`/running states → blue
   in-progress styling; never unmapped — regression ae44135). Sweep every
   page/component that renders a status string (RunStatusBadge, run detail,
   /hitl2, /edit, topics board, ledger) to use it.
2. **Shared nav**: align `Masthead.tsx` to the demo's masthead/nav and ensure
   every page renders it (one component, active-link underline, `+ New run`).

## Phase 3 — /runs page rebuild (frontend, the bulk of the work)

New components under `web/components/runs-ledger/` (replace the old grid/desk
board on `/runs`):

1. **Toolbar** — status tabs with client-derived counts (default tab
   `drafted`), search, voice filter, sort (newest / oldest-first backlog).
2. **Table + row** — columns and 3-line topic cell per spec §4.4 (flags, SEO
   snippet, mono id line with run id / slug / `WP#id`), CMS destination
   mini-lines, `YYYY-MM-DD HH:MM` created. Selection model (row checkboxes +
   select-all-visible).
3. **Drawer** — bottom sheet w/ ↑↓ + `j`/`k` stepping, Esc close:
   - Brief column (incl. operator-brief clamp + Version history link).
   - Default mode: SERP-style draft preview + CMS destination form
     (SEO title/meta → snapshot autosave; author/category/slug/status/date →
     debounced `PATCH /runs/:id`), status-dependent actions incl. dry-publish
     `target_label` confirm before approve-publish.
   - Outlined mode: gap-analysis panel (`GET /runs/:id/gap-analysis`) +
     outline panel (`GET /runs/:id/outline`), Approve outline / Reject.
   - Data: `GET /runs/:id` on open (TanStack Query, keep list fresh via
     invalidation).
4. **Combobox** — searchable single-select; options + selected value show
   `name · WP#id` (spec §2.1); options from `GET /wp-options?run_id=`;
   grouped by CMS target; proper combobox a11y/keyboard. Evaluate extending
   the existing `SearchableSelect.tsx` before writing new.
5. **Bulk bar + Set-CMS-metadata modal** — fan-out helpers (concurrency ~4,
   per-run result collection, aggregate toast, failures stay selected),
   conditional buttons (publish→drafted subset, restart→failed subset),
   role-gated via existing capability model.
6. **Responsive** — card list + stacked 92dvh drawer with sticky actions per
   spec §5; verify at 390px.

## Phase 4 — Tests

- Vitest: status-label helper (full status matrix), row rendering (flags, id
  line, destination cell), combobox filtering + `name · TAG#id` rendering,
  bulk fan-out helper (success/partial-failure aggregation), drawer mode
  switch (drafted vs outlined).
- Playwright e2e (dedicated port, not :3000): tab filter → open drawer →
  edit a metadata field (PATCH fired) → bulk select → modal apply; mobile
  viewport pass.

## Phase 5 — Deploy & verify (dev → prod)

1. Deploy backend+web to **dev** (`npm run deploy:dev` /
   `NEXT_PUBLIC_*… npm run cf:deploy:dev` — never a bare `cf:deploy:dev`,
   it bakes the wrong `NEXT_PUBLIC_*`).
2. Self-verify on dev with `scripts/claude-debug/` (login → `/runs` →
   screenshots of: drafted tab, drawer both modes, bulk bar, mobile emulation)
   — guards already block resume/publish, so gate actions are eyeball-only.
3. Operator sign-off on dev → push `main` (CI deploys prod) → prod smoke
   (health + /runs renders, tab counts sane).

## Acceptance checklist

- [ ] Pixel-faithful to `design/runs-redesign/runs-redesign.html` at desktop
      and mobile (allowing real-data variance), incl. hybrid editorial
      masthead + modern table.
- [ ] Spec §2 deltas implemented (combobox `name · TAG#id`; all live statuses
      mapped, none invisible).
- [ ] `drafted`/`outlined` labels consistent across ALL pages; shared nav on
      all pages.
- [ ] Every drawer/bulk action hits the existing endpoint listed in spec §6;
      dry-publish `target_label` confirm preserved on approve-publish.
- [ ] Only backend change = list-payload `seo_title`/`meta_description`;
      parity gate green; pyright/ruff/tsc/eslint clean; Vitest + pytest green.
- [ ] Verified on dev (claude-debug screenshots) before prod.
