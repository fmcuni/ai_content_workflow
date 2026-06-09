# Plan — Real-time collab + per-author attribution

- **Date:** 2026-06-09
- **Spec:** [2026-06-09-realtime-collab-per-author-attribution.md](../specs/2026-06-09-realtime-collab-per-author-attribution.md)
- **Status:** PROPOSED

Decisions locked: **full real-time** collab · blame on **live cursors + Review
panel** · **all run-editor surfaces**.

## Phase 0 — Spike (de-risk before committing)

Prove the stack end-to-end locally before any production wiring.

### 0a. Backend RunDoc sync DO — ✅ DONE 2026-06-09 (TDD, green in workerd)

- Added `yjs` + `y-protocols` + `lib0` and `@cloudflare/vitest-pool-workers@0.16`
  (peers vitest 4) to `deploy/cloudflare-workers/`.
- `src/run-doc.ts` — `RunDoc` DO: hand-rolled y-websocket sync + awareness relay
  over WebSocket, server-issued cursor colour (locked decision), debounced
  persist of the merged doc to DO storage. In-memory conn Set (hibernation
  deferred to Phase 1).
- TDD harness: `src/run-doc.harness.ts` (hermetic worker entry, RunDoc only),
  `vitest.workers.config.ts` (v4 plugin API: `cloudflareTest(...)`),
  `tsconfig.workers-test.json`, scripts `test:workers` / `typecheck:workers`.
- `src/run-doc.workers.test.ts` — **5 tests green inside workerd**: relay between
  two clients · concurrent-merge no lost chars · late-joiner state sync · presence
  (awareness) relay · distinct server-issued colour per session.
- Gotcha captured: workerd delivers binary WS frames as **Blob** — set
  `binaryType = "arraybuffer"` on both server and client.
- Verification: `test:workers` 5/5 · node-env suite 424/424 (unchanged) ·
  `typecheck` + `typecheck:workers` both rc=0.

### 0b. Frontend Yjs→HTML round-trip — ✅ DONE 2026-06-09 (TDD, green in jsdom)

- Added `yjs`, `y-protocols`, `y-prosemirror`, `@tiptap/extension-collaboration`
  to `web/` (collaboration pinned to **3.23.5** — TipTap pins core exactly, so
  the default `^3` resolved to 3.26.0 and ERESOLVE'd against core 3.23.5).
- `web/components/tiptap/collab-roundtrip.test.tsx` — **2 tests green**:
  1. HTML → Yjs doc → second client → HTML is **byte-identical** to what today's
     non-collaborative editor produces (`baselineHtml`), i.e. Yjs adds ZERO loss;
     FAQ accordion, table, link, review anchor, and CJK all preserved.
  2. Two divergent Yjs docs exchange updates and **converge** to identical HTML
     with the FAQ widget intact (CRDT merge on the real schema).
- Finding: TipTap normalises tables (`<table style>`, `<colgroup>`,
  `<p>`-wrapped cells) on load — but identically with or without collaboration,
  so it is NOT a collab regression. The byte-equality vs the non-collab baseline
  is the honest fidelity bar (not equality vs the raw input).
- Verification: web vitest 331/331 (incl. these 2), tsc clean on the new file.

**Exit gate — PASSED:** concurrent merge with no lost chars (0a ✅ + 0b ✅);
FAQ / table / link round-trip is lossless relative to the editor baseline.
Phase 0 de-risk complete — clear to proceed to Phase 1 (production wiring).

## Phase 1 — Backend: RunDoc DO + persistence

- `deploy/cloudflare-workers/src/run-doc.ts` — `RunDoc` DO: WS sync + awareness,
  update log in DO storage, alarm-based awareness sweep + log compaction.
- Bind in `wrangler.jsonc` (`durable_objects`) and `Env` in `src/index.ts`
  alongside `RUN_STREAM` / `GEMINI_PROXY`.
- WS route on the backend Worker (auth handshake = better-auth session; CORS via
  `FRONTEND_ORIGIN`, mirror `run-stream.ts`). Reject writes below content-editor.
- Migration `supabase/migrations/<ts>_run_collab_state.sql`: `run_collab_state`
  (`run_id` pk, `ydoc` bytea, `state_vector` bytea, `updated_at`). Cold-start
  load + periodic backup.
- **Tests:** Vitest for DO sync/auth/compaction; migration applies under
  `supabase db reset`.

## Phase 2 — Frontend: collaborative editor + presence

- Extend `web/components/TipTapEditor` to optionally mount `Collaboration` +
  `CollaborationCursor` bound to a `RunDoc` WebSocket provider; keep the existing
  non-collab path behind a feature flag for safe rollout.
- New `web/lib/run-editor/useCollabDoc.ts`: open the provider for a `runId`, wire
  awareness user `{ email, name, colour }` from the session.
- Presence UI: caret + name label (CollaborationCursor render); connected-editors
  avatars in `RunEditorShell`/`EditorRail`.
- Disable `useSnapshotAutosave` body writes when collab is active (DO is the live
  source); snapshots become flatten-on-event (Phase 3).
- **Tests:** Vitest/RTL for `useCollabDoc` + presence render.

## Phase 3 — HTML derivation + snapshot / publish integration — ✅ DONE 2026-06-09 (frontend-only, flag OFF)

Confirmed FRONTEND-ONLY: flatten/seed need a DOM (a headless TipTap `Editor`),
which workerd lacks → they run client-side and the backend publish/snapshot
routes are byte-for-byte unchanged. The feature flag was NOT flipped (Phase 5);
collab is mounted **disabled** on the pages so the whole path is inert and
byte-identical until the flag flips.

- **Schema SSOT** `web/components/tiptap/editor-extensions.ts` —
  `buildEditorExtensions({ collabDoc?, caret? })` is the ONE source for the live
  editor, flatten, seed, AND the round-trip test (kills the FAQ-flatten drift
  class). `TipTapEditor` refactored to consume it (non-collab path byte-identical;
  `TipTapCollab` now exported).
- **Flatten/seed** `web/lib/run-editor/collab-html.ts` — `flattenCollabDoc(ydoc)`
  (byte-identical to the non-collab editor for the FAQ/table/link/anchor/CJK
  fixtures) + `seedCollabDocIfEmpty(ydoc, draftHtml)` (idempotent; no-op on a
  non-empty doc).
- **Seed flow** `web/lib/run-editor/useSeedCollabDoc.ts` — seeds the shared doc
  once from the generated draft, but ONLY after `status === "connected"` (post DO
  sync) so a returning run's persisted doc is never re-seeded; per-`ydoc` guard.
  **Seed-race decision:** client-only emptiness guard (the recommended default).
  Safe for the single-opener case and any returning run; the ONLY residual is two
  brand-new first-joiners within the sync round-trip. A fully race-free fix needs
  a backend "you-are-the-seeder" signal from the RunDoc DO — deferred to Phase 5
  hardening (it would re-touch the committed Phase 1 DO + its 8 pool tests).
- **Snapshot/publish wiring** — `useSnapshotAutosave` gained an optional
  `flattenBody?: () => string`; when collab is active it sources the persisted
  body from the flattened live doc (replacing the Phase 2 "skip"); when absent it
  keeps the skip. `/hitl2` + `/edit` mount `useCollabDoc({ enabled:
  isCollabEnabled() })` (disabled handle when the flag is off), forward `collab`
  through `ArticleEditor → TipTapEditor`, mount `useSeedCollabDoc`, and source the
  HITL_2-approve / save / re-push / WP-preview body from `flattenCollabDoc` when
  collab is active (else the unchanged `html` string). `/regenerate` deferred to
  Phase 5.
- **Tests:** collab-html byte-equivalence + seed round-trip/no-op; useSeedCollabDoc
  seed-once / not-connected / disabled / non-empty / two-first-joiners; autosave
  flatten-source vs the Phase-2 skip. web vitest **369/51 green**, tsc + eslint
  clean. Backend untouched → workers suites unaffected (8 pool + 434 node).

## Phase 4 — Per-author attribution in Review panel — ✅ DONE 2026-06-09 (frontend-only, flag OFF)

De-risk spike first (real SSOT schema, two authors exchanging Yjs updates) proved:
insertion blame is char-precise via `getUserByClientId`; deletion blame works via
`getUserByDeletedId` **iff the doc is `gc:false`** (tombstone content must survive)
and the `setTimeout(0)` ds-recording has flushed (eventually-consistent in prod);
the ydoc char-walk aligns byte-for-byte with the flattened text EXCEPT at FAQ atoms
(text is attribute-stored, re-emitted by `renderHTML`); and HTML-string-diff hunk
boundaries are NOT authorship boundaries (a clean Yjs delete+insert fragments into
author-mixed hunks). USER chose **full insert+delete char-precise + node-level FAQ**.

- **Blame core** `web/lib/run-editor/collab-blame.ts` — `buildBlameResolver(ydoc,
  awareness?)` (null when no doc). Walks the shared doc into live/tombstone char
  sequences + FAQ-atom elements, then **drives attribution off the diff `parts`**
  (the design the spike validated — no committed-side reconstruction): `added`
  text → next live chars → `getUserByClientId`; `removed` → next deleted chars →
  `getUserByDeletedId`; `unchanged` advances the live cursor only. Atom text is
  detected via the `editor__faq` wrapper, skipped from the char cursors (so prose
  AFTER a widget stays aligned) and attributed at the NODE level. A hunk gets its
  **dominant** author (plurality); colour from awareness (else neutral). Reads Yjs
  internals defensively — a scan error degrades to unattributed hunks.
- **Registration** `useCollabDoc.ts` — doc is now `new Y.Doc({ gc: false })` and
  `createInstances` registers `Y.PermanentUserData.setUserMapping(doc, clientID,
  name)` (held on `CollabInstances`). Disabled path never calls it → side-effect
  free. Existing 8 tests stay green (yjs records deletions only for `local`
  transactions, so no spurious users-map writes on remote updates).
- **Type** `tracked-changes.ts` — additive optional `author?: HunkAuthor {name,
  color}` on `Hunk`; `computeTrackedChanges` stays authorship-agnostic / byte
  identical.
- **Popover** `InlineTrackedChanges.tsx` — optional `resolver` prop; annotate the
  pure diff in a separate step; render "Added/Removed by {name}" coloured via
  `safeCollabColor`. No resolver → `author===undefined` → popover/diff
  byte-identical to non-collab. Wired from `ArticleEditor` (resolver built from the
  `collab` prop, memoized; null collab → null resolver).
- **Tests:** collab-blame 7 (insertion/deletion blame, offset past a FAQ atom,
  dominant author, colour, null no-op); InlineTrackedChanges +3 (Added-by,
  Removed-by, no-resolver no attribution). web vitest **379/52 green**, tsc +
  eslint clean. Backend untouched → workers suites unaffected (8 + 434).
  typescript-reviewer pass applied (item-start delete id, null-child walk guard,
  scan try/catch, clarified tag handling, stored PUD).

## Phase 5 — Roll across all run-editor surfaces

- Flip the flag on `/hitl2`, `/edit`, `/regenerate`, read-only `/runs/[id]`
  (all already share `components/run-editor` + `lib/run-editor`).
- Read-only surface joins as observer (awareness presence, no write).
- **E2E:** Playwright two-context test — concurrent typing, cursors visible,
  blame correct. **Use a dedicated port, not :3000** (shared with another app).

## Phase 6 — Parity, deploy, cleanup

- `node deploy/cloudflare-workers/parity/check-parity.mjs` (read-only routes
  unaffected; confirm no regression).
- Deploy backend Worker (DO migration) **before** web Worker.
- `graphify update .`; update `CLAUDE.md` architecture section (RunDoc DO).

## Optional follow-on (not v1)

- Move run metadata (SEO/WP fields) into a shared `Y.Map` so the whole form is
  collaborative; retire the `expected_version` 409 path for metadata too.

## Test strategy summary

- **Unit/Vitest:** DO sync/auth/compaction, flatten round-trips, blame mapping.
- **Integration:** migration apply; snapshot/publish flatten equivalence.
- **E2E/Playwright:** two-context concurrent edit + cursors + blame (dedicated
  port).
- Target ≥80% on new modules; keep ruff/pyright/tsc/eslint clean.

## Rollback

Feature-flagged: disabling the flag reverts every surface to the current
string-snapshot editor. The `run_collab_state` table and `RunDoc` DO are additive
— a flag-off deploy needs no migration rollback.
