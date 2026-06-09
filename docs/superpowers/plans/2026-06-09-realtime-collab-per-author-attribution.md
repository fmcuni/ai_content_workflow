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

## Phase 3 — HTML derivation + snapshot / publish integration

- `web/lib/run-editor/flattenCollabDoc.ts`: Yjs/ProseMirror doc → HTML using the
  identical schema (FAQ/table/link safe).
- Seed-once on HITL_2 entry: if the run's Yjs doc is empty, initialise from the
  generated draft HTML (idempotent, server-side in the DO or first-client).
- Flatten on snapshot/manual-save/HITL_2-approve → feed existing snapshot +
  version-history + publish pipeline unchanged (`runs.ts` snapshot routes,
  `publish.py` / Workers publish).
- **Tests:** round-trip fixtures (FAQ accordion, tables, links, CJK); publish
  HTML byte-equivalence; version-history snapshot shape unchanged.

## Phase 4 — Per-author attribution in Review panel

- Wire `Y.PermanentUserData` into the doc (register the awareness user).
- Extend `Hunk` (`web/lib/tracked-changes.ts`) with optional `author`; map a
  working-doc position range → user via `PermanentUserData`.
- `InlineTrackedChanges.tsx` popover renders "Added/Removed by {name}".
- **Tests:** `tracked-changes.test.ts` blame-mapping cases; component test for the
  popover author line.

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
