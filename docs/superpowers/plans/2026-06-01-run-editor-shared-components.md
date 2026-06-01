# Plan — Shared run-editor components (TDD)

**Spec:** [2026-06-01-run-editor-shared-components.md](../specs/2026-06-01-run-editor-shared-components.md)
**Method:** Test-Driven. RED (failing tests) → GREEN (implement) → REFACTOR/rewire → VERIFY.

## Build order (phases)

### P0 — Harness + RED (lib)
- Add Vitest + RTL dev deps; `vitest.config.ts`, `vitest.setup.ts`, `package.json` scripts.
- Write `web/lib/run-editor/form.test.ts` covering every function in spec §A.
- Tests fail (module absent) → RED confirmed.

### P1 — GREEN (lib pure logic)
- Implement `web/lib/run-editor/form.ts` to pass `form.test.ts`.
- Implement `web/lib/run-editor/useWpPayloadPreview.ts` (no unit test; thin hook).

### P2 — RED + GREEN (components)
- Write `RunEditorShell.test.tsx`, `EditorRail.test.tsx`, `NotesToAi.test.tsx`.
- Implement the three components in `web/components/run-editor/` to pass.

### P3 — Rewire pages (no new tests; tsc + visual guard)
- `/hitl2`: replace chrome with `RunEditorShell`; rail with `EditorRail`; notes
  with `NotesToAi`; payload with `useWpPayloadPreview`; snapshot/dry helpers with
  `form.ts`. Keep autosave, hydration, decision gate, version history in the page.
- `/edit`: same shell/rail/notes/payload/form swap. Keep outline, manual save,
  re-push confirm, restore in the page. Delete its local `buildSnapshot`/
  `buildDryRequest`/`buildArticlePayload`/`asPublishStatus`.
- `/regenerate`: shell + NotesToAi (no apply) only; keep its comments-only aside
  and regenerate mutation. **No feature change.**
- Dedupe `isBlankBody` in `Hitl2VersionHistory.tsx` → import from `form.ts`.

### P4 — VERIFY (fan-out)
- `npx tsc --noEmit` / lint clean (no NEW errors on touched files).
- `npm test` green.
- code-review pass on the diff (immutability, no behavior drift, no `any`).
- Visual/Playwright smoke on the live :3000 server.

## Risk notes
- HITL_2 autosave/hydration is the trickiest; the shell/rail/notes extraction is
  presentational only — the stateful logic must stay in the page untouched.
- `snapshotKey` field order MUST stay byte-identical or dirty-tracking breaks.
- Don't let Vitest pick up `tests/e2e/**` (Playwright). Scope `test.include`.
