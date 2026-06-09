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

## Phase 5 — Roll across all run-editor surfaces — ✅ DONE 2026-06-09 (local-only, flag still OFF)

**Go-live decision (asked, not assumed):** committed default
`NEXT_PUBLIC_COLLAB_ENABLED` stays **OFF**; every surface RESPECTS the flag and
was validated with it forced on locally. Prod stays inert until an explicit
Phase-6 cutover. Session was LOCAL-ONLY: no push, no deploy, no `supabase db
push/reset`.

**Two brief assumptions corrected against the actual code:**
- `/regenerate` is a RETIRED server-side redirect to `/edit` (the endpoint was
  never ported to Workers — see CLAUDE.md). There is no editor to wire collab
  into → left as the redirect. (User confirmed: skip.)
- `/runs/[runId]` is a progress/status page with NO article editor. "Observer
  mode" needs an editor to attach to. (User chose: SKIP the run-detail surface —
  build the observer capability as infra + tests only; wire presence into the
  hitl2/edit shell.)

Delivered (commits `27ff915`, `cd492bd`, `aadf83e`, `0d99da4`, `ef16cfb`):

- **Observer / read-only capability (5A, infra — no live surface yet).**
  `useCollabDoc` gained `readOnly`: opens the socket, RECEIVES remote edits, and
  PUBLISHES awareness, but relays NO local doc updates and never seeds.
  `TipTapEditor` gained an `editable` prop: observer mode hides the toolbar +
  suppresses all selection/link mutations while the bound Yjs doc still streams
  live remote edits + carets (`setEditable` sync effect). + unit/RTL tests.
- **Seed-race "you-are-seeder" DO signal (5D).** `RunDoc` MESSAGE_INIT now carries
  `{ color, primary }`; `primary=true` only for the FIRST connection to reach an
  empty doc with no seeder assigned (sticky `seederWs`, released on seeder close
  while still empty; schema-agnostic `docIsEmpty` via `encodeStateAsUpdate`
  length, biased to "empty" on encode error). `useCollabDoc` parses `primary` →
  `isSeedAuthority` (forced false in observer mode; missing flag → false,
  back-compat). `useSeedCollabDoc` now gates seeding on `isSeedAuthority`,
  closing the two-first-joiners duplicate-seed window the client guard couldn't.
  +3 pool tests (11 total). **KNOWN caveat (documented in code):** the DO grants
  `primary` regardless of role, so a read-only observer opening an empty run
  before any editor would consume the seeder slot. Harmless today (no observer
  surface); when one is wired, the DO grant must skip observers (e.g. an
  `?observe=1` upgrade query) — close before shipping an observer surface.
- **Presence in the shared shell (5C).** `RunEditorShell` gained a collab-agnostic
  `presence` ReactNode slot in the back-link row; `/hitl2` + `/edit` render
  `<CollabPresence awareness={…}>` into it (null/empty when collab off or alone)
  and forward `isSeedAuthority` into `useSeedCollabDoc`. + shell render test.
- **E2E (5E).** `web/tests/e2e/collab-realtime.spec.ts` — two authenticated
  contexts on one run's `/edit`: concurrent typing converges, remote caret +
  name label visible, presence stack shows both, Review popover shows per-author
  blame. SKIP-gated on `E2E_COLLAB_BASE_URL` (a LOCAL stack with the flag on) so
  it can NEVER run against prod (collab OFF there; the test types into the body).
  Validated for discovery + tsc + eslint; NOT executed against a live stack this
  session (needs `wrangler dev` + web dev on a dedicated port + creds — recipe in
  the spec header). **Dedicated port, not :3000** (shared with another app).

**Flag-OFF stays byte-identical** (confirmed in code + tests): disabled handle →
no socket, `awareness` null → `CollabPresence` renders nothing, `editable`
defaults true, seeding never runs.

Verification: web vitest **388/53** (+9), tsc + eslint clean; workers **11 pool**
(+3) + **434 node**, `typecheck` + `typecheck:workers` clean. typescript-reviewer
pass: no CRITICAL/HIGH; one MEDIUM hardening applied (`docIsEmpty` error bias).

## Phase 6 — Parity, deploy, cleanup — ✅ DONE 2026-06-09 (backend live; web shipped collab-DARK)

Go-live decision (operator): **option (a)** — deploy backend + DO + migration to
prod, ship the web Worker with `NEXT_PUBLIC_COLLAB_ENABLED` **unset (collab dark)**.
Collab stays inert in prod until a follow-up web deploy flips the build-time flag.
Branch merge to `main` was **NOT** authorized this session — branch left unmerged.

What shipped:
- **Migration:** `supabase db push` applied `20260612000000_run_collab_state.sql`
  to the linked prod project (dry-run confirmed it was the sole pending migration;
  remote history now records it). Additive — new table + RLS + `content_tool_app`
  grant.
- **Backend Worker** (`bowtie-content-tool-poc`): `npx wrangler deploy` → version
  `e4162e9d-2894-4a63-815a-516856863316`. Bindings confirm `RUN_DOC (RunDoc)` DO +
  `HYPERDRIVE` (so the Postgres cold-store persists in prod). Smoke: `/health` 200;
  `/runs/<id>/doc` WS upgrade without a ticket → **401** (auth-gated, expected).
  Rollback handle (prior version): `b7292180-e1f8-42ca-b9c8-addff6f79fcc`.
- **Web Worker** (`bowtie-content-tool-web`): `NEXT_PUBLIC_API_BASE=<prod backend>
  npm run cf:deploy` (collab flag omitted → dark) → version
  `66a65f74-dcc9-451b-b74b-d6fbe7f8fbfb`. Smoke: `/` 307→/login, `/login` 200,
  `/api/auth/get-session` 200 (apibase footgun avoided). Non-collab web diffs
  (`InlineTrackedChanges`/`tracked-changes`/`globals.css`) verified inert with the
  flag off ("byte-identical to before" without a blame resolver). Rollback handle
  (prior version): `bcfd3e18-7469-420a-90df-7fb60275538c`.

Parity: `check-parity.mjs` could not run a **live** diff headlessly (it discovers
routes by querying the Python reference at `localhost:8000`, which was not running).
Static analysis confirmed the new WS `/runs/:id/doc` route is **outside** the gate's
22 read-only-JSON-route scope, and the `runs.ts` diff is purely additive — no
read-only-route regression. A conclusive live PASS needs the Python backend up.

Docs: `CLAUDE.md` Architecture section gained a `RunDoc` Durable Object subsection.

### Still owed (pre web-ON flip gate)
- **Live two-context e2e** (`web/tests/e2e/collab-realtime.spec.ts`): NOT run this
  session. It needs a local `wrangler dev` backend + DB-backed run data; the only
  isolated local DB is Supabase-local, which needs Docker (was DOWN). Running it
  against the prod DB would write test snapshots into a real run, so it was
  **deferred**. Run it on an isolated/local DB (Docker up) as the gate **before**
  flipping `NEXT_PUBLIC_COLLAB_ENABLED=true` in a web deploy.
- **Authenticated UI eyeball** of prod (login behind the `@bowtie.com.hk` better-auth
  + WAF gate) — could not be done headlessly. Manual check owed.
- **Merge to `main`** (bridges fmcuni + bowtie-ins) — operator to run when ready.

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

## Phase 7 — CI e2e gate + rollout ✅ DONE (2026-06-09)

- **Live two-context e2e could not run on the dev machine** — the dual-browser +
  dual-dev-server load triggered a >100GB memory leak that froze the box twice.
  The gate was **moved to CI**: `.github/workflows/collab-e2e.yml` spins an
  isolated local Supabase (all migrations + seed), seeds one run→draft→render,
  signs up a staff user, builds web **collab-ON** against a local `wrangler dev`
  backend (RUN_DOC DO + Hyperdrive shim → local DB), and runs the spec. Nothing
  touches prod (spec SKIP-gated on `E2E_COLLAB_BASE_URL`).
- **Harness fixes** (the spec was authored but never run live): added
  `web/playwright.collab.config.ts` (the documented `--config=playwright.prod.config.ts`
  matched 0 tests — its `testMatch` is the visual smoke); discover the run via the
  authenticated `/api/runs` instead of scraping the Ledger board (no per-run link);
  type the two tokens at **opposite doc ends** (same-offset concurrent inserts
  legitimately interleave under any CRDT); assert the visible caret **name-label**
  (the caret bar is a ~0-width marker Playwright calls "hidden").
- **CI gate GREEN** (run 27198968283) for: convergence/no-loss, remote caret +
  name label, presence stack (≥2 sessions), and the Review actions popover.
- **Blame attribution DESCOPED from the e2e** → **follow-up**: in the live
  two-context path the Review popover opens (accept/reject) but renders **no**
  `Added by {name}` line — author resolves null for every hunk; `scanDoc` does not
  throw. `collab-blame.test.ts` passes in isolation, so the resolver logic is
  sound; the gap is the live wire/seed path. Needs runtime Yjs-doc inspection on a
  non-OOM machine.
- **Rolled out:** merged branch → `main` (`db18992`), then flipped collab **ON**
  durably by setting `NEXT_PUBLIC_COLLAB_ENABLED=true` in the **web deploy step of
  `deploy-workers.yml`** (`3c21ff1`) — a one-off manual `cf:deploy` would be
  reverted to dark by the next main push. Deploy run 27199353520 succeeded.
  Prod smoke: `/health` 200, web `/` 307, `/login` 200, `/api/auth/get-session`
  200 (no API-base footgun). **Web** `e650bdf8-a79b-4f60-956a-9cd721aebe00`,
  **backend** `b2cdc484-9f4e-4d9f-a86d-d46f9e42d8d2`.
- **Rollback the flip:** set `NEXT_PUBLIC_COLLAB_ENABLED` to `false` (or remove) in
  `deploy-workers.yml` + redeploy, or `wrangler rollback 66a65f74-...` (last dark
  web build) — backend untouched, collab goes dark.
- **Still owed:** authenticated **manual browser eyeball** of prod collab (headless
  login 401s behind WAF/PSL) + the blame follow-up above.
