# Run-editor parity + task-brief enrichment

Date: 2026-06-08

Four operator-UI refinements across the run pages.

## 1. Align /edit and /hitl2 toolbar (full parity + autosave)

Today the "Saved <time> · ⤓ Save · ⟲ Version history" cluster and the autosave
that backs it exist **only** on `/hitl2` (via the shell's `headerActions` prop and
~180 lines of inline snapshot logic). `/edit` has no autosave; its Version-history
button sits in the tab bar and Save lives only in the bottom action bar.

**Decision (user):** full parity + autosave on `/edit`.

**Approach (DRY, low-risk):** extract hitl2's working logic into shared units,
adopt on hitl2 first (behavior-identical), then reuse on /edit:

- `components/run-editor/RunEditorHeaderActions.tsx` — presentational cluster.
- `lib/run-editor/useSnapshotAutosave.ts` — autosave / dirty / hydrate hook,
  parameterized per page by `snapshotIn`, `baselineKey`, `onHydrate`, `ready`,
  `hydrateEnabled`, `submittedRef`, `editorEmailRef`.

`/edit` keeps its bottom-bar **Save changes** (persist outline + article to the
render) and **Save & re-push**; the header **⤓ Save** writes a version snapshot,
matching hitl2. `/edit` now hydrates from the latest snapshot on load (resume),
like hitl2. Snapshots remain article-only — outline edits are still persisted via
"Save changes".

## 2. Task brief fields

`components/RunTaskDetails.tsx` (shown on /hitl1, /hitl2, /edit, run-detail) gains:

- **Edit note** — `run.edit_note` (when present).
- **Source URL** — `run.article_url`, rewrite runs only (`!isCreate`).
- **Topic batch** — resolved batch label + link, via a new
  `lib/run-editor/useTopicBatchForRun.ts` hook extracted from the run-detail page
  (walks batches by `topic_candidate_id`).

## 3. Empty Adv ID / Widget ID → "none"

Replace the em-dash fallback with the literal "none" wherever the IDs are shown as
**labeled fields**: `RunTaskDetails` (Adv ID, Widget ID) and `RunRow` read-only
cells. The compact `/` and `/runs` desk chips keep **omitting** empty IDs
(user decision — no clutter).

## 4. Remove "Paste rows…"

Delete the bulk-paste control and its backing code in `app/runs/new/page.tsx`
(`bulkOpen`/`bulkRaw` state, `applyBulk`, the button, the tray, and the now-dead
`Textarea` import). Fully isolated — no shared deps, no tests.
