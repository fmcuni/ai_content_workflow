# Plan — Voice Studio Drafts, Reflection & Entrance

**Date:** 2026-06-22
**Spec:** `docs/design/specs/2026-06-22-voice-studio-drafts-and-entrance.md`
**Status:** Plan — pending approval (no code yet)

Build order is bottom-up: backend assembly first (cheap to test in isolation),
then the draft store, then the editor wiring, then save-all + guard, then the
entrance. Each phase is independently testable; deploy to **dev** and self-verify
before prod (dev-first directive).

---

## Phase 0 — Entrance (independent, ship-first)
Smallest, zero-risk, no backend.

1. `web/components/voices/StudioEntryBand.tsx` (new, presentational): kicker +
   one-line descriptor + primary CTA `Open {selected-voice} in Studio →`,
   `href={/voices/${slug}}`. Disabled/placeholder state when no voice selected.
2. `web/app/voices/page.tsx`: render `<StudioEntryBand slug={selectedSlug} />`
   between the Rolodex and the Style Card; **remove** the inline
   `Open in Studio →` link from the Press Workflow section.
3. Test: `StudioEntryBand.test.tsx` (renders CTA for selected voice; correct
   href; empty state).

**Gate:** web tsc/eslint/vitest green → deploy dev → claude-debug screenshot.

---

## Phase 1 — Multi-override assembly (backend, both stacks)
No API contract change yet — pure engine generalization + tests.

1. **Workers TS** `prompts/store.ts`:
   - `resolveBodyWithOverride` → `resolveBodyWithOverrides(body, snap,
     overrides: Map<string,string>, seen)`.
   - `assembleWithOverride(routeId, snap, {overrideName, overrideBody})` →
     keep a thin shim delegating to `assembleWithOverrides(routeId, snap,
     new Map([[overrideName, overrideBody]]))` so existing callers are untouched.
2. **Python** `content_tool/api/routes/prompts.py`: mirror
   `_assemble_with_override` → multi-override map equivalent.
3. Tests: multiple partials, nested includes, precedence (override wins over
   stored), empty map == stored assembly. TS vitest + Python pytest.

**Gate:** Workers vitest + tsc green; Python ruff/pyright/pytest green.

---

## Phase 2 — Preview contract: draft overrides (backend, both stacks)
Wire the optional draft inputs into `POST /templates/:id/preview`.

1. **Workers TS** `routes/prompts.ts` + `prompts/editor.ts`:
   - Parse optional `partial_overrides` (record of id→body), `source_policy`,
     `glossary` (each parsed/defaulted; non-object ⇒ 422; absent ⇒ no-op).
   - Thread `partial_overrides` into `assembleWithOverrides`.
   - Thread `source_policy` draft → render to `{source_policy_block}` via the
     policy `toPromptBlock` path (reuse `source_policy/store` rendering; do not
     hand-render on client).
   - Thread `glossary` draft into `defaultPersonaBlock`/`toPromptBlock` as a
     persona override, mirroring `localeOverride`. **Finalize** the persona
     override signature here (likely `{ locale?, glossary? }` → one
     `personaOverride` object).
2. **Python** mirror in `prompts.py` + persona/source-policy preview helpers.
3. Tests: each override reflected; combined overrides; absent ⇒ byte-identical;
   **parity** TS↔Python for identical inputs.

**Gate:** both stacks green; parity check.

---

## Phase 3 — Studio draft store (web)
1. `web/lib/voice-studio/draft-store.tsx` (new): `StudioDraftProvider` +
   `useStudioDraft()`. Reducer-based; keyed by `voice`; derives `dirtyPromptIds`,
   `dirtyConfigKinds`, `unsavedCount`. Pure reducer extracted to `draft-store.ts`
   for unit testing.
2. Mount the provider in `web/app/voices/[slug]/page.tsx` wrapping the canvas +
   inspector.
3. Tests: reducer dirty derivation, per-voice reset, config + prompt coexistence.

**Gate:** web tsc/eslint/vitest green. No UI behavior change yet (store unused).

---

## Phase 4 — Editor + config panels read/write the store
1. `web/components/prompts/PromptEditor.tsx`: when `useStudioDraft()` context is
   present, source `buffer`/`sha` from the store and write edits back to it;
   else keep current local `useState` path (library page unchanged). Preview
   sends the full draft map (partials + dirty config) from the store; preview
   re-runs on any relevant draft change.
2. `web/components/voice-studio/VoiceConfigInspector.tsx` panels: write drafts
   into `config` instead of panel-local state when in Studio.
3. Tests: node-switch preserves draft; consumer preview reflects sibling partial
   drafts; locale/glossary/source-policy drafts reflect.

**Gate:** web green → deploy dev → claude-debug: edit two partials, open writer,
confirm both reflected; switch nodes, confirm drafts persist.

---

## Phase 5 — Save-all + reporting + loss guard
1. `web/lib/voice-studio/use-save-all.ts`: pre-validation gate (placeholders,
   byte cap) → sequential dispatch (prompt `PUT`s + config writes) → discriminated
   per-item results → toast `Saved X of N` + flag conflicts dirty.
2. Studio header (`web/app/voices/[slug]/page.tsx`): unsaved indicator
   (`● N unsaved`) + primary `Save all · N` (amber when dirty, quiet otherwise) +
   `Discard all`; optional batch-note field in the save flow.
3. In-editor save button → calls the same `useSaveAll()`; per-node "revert this
   draft".
4. `web/lib/voice-studio/use-unsaved-guard.ts`: `beforeunload` + Next nav
   intercept when `unsavedCount > 0`.
5. Tests: pre-validation abort + node jump; partial-failure reporting; baseSha
   update on success; guard fires/clears.

**Gate:** web green → deploy dev → claude-debug: force a 409 (edit, save elsewhere)
and confirm "Saved X of N · 1 conflict"; confirm guard on reload/leave.

---

## Phase 6 — Prod
1. Full local gate: Workers vitest+tsc, Python ruff/pyright/pytest, web
   tsc/eslint/vitest.
2. PR; gate prod on green PR CI (split-migration ordering N/A — **no migrations**
   in this feature).
3. Deploy prod (both Workers); smoke health/runs/web; authed eyeball of entry
   band + Studio save-all.

---

## File inventory (new / touched)

**New (web):**
- `web/components/voices/StudioEntryBand.tsx` (+ test)
- `web/lib/voice-studio/draft-store.tsx` + `draft-store.ts` (+ test)
- `web/lib/voice-studio/use-save-all.ts` (+ test)
- `web/lib/voice-studio/use-unsaved-guard.ts` (+ test)

**Touched (web):**
- `web/app/voices/page.tsx` (entry band; remove inline link)
- `web/app/voices/[slug]/page.tsx` (provider mount; header save-all + indicator)
- `web/components/prompts/PromptEditor.tsx` (store-aware; multi-override preview)
- `web/components/voice-studio/VoiceConfigInspector.tsx` (drafts → store)
- `web/lib/api.ts` (preview body: `partial_overrides`, `source_policy`, `glossary`)

**Touched (Workers TS):**
- `deploy/cloudflare-workers/src/prompts/store.ts` (multi-override)
- `deploy/cloudflare-workers/src/prompts/editor.ts` (persona/glossary/policy override)
- `deploy/cloudflare-workers/src/routes/prompts.ts` (preview contract)
- (+ `.test.ts` siblings)

**Touched (Python, parity):**
- `content_tool/api/routes/prompts.py` (multi-override + preview contract)
- persona / source-policy preview helpers as needed (+ tests)

**No migrations. No new env/secrets.**

---

## Open item to finalize during Phase 2
Exact **persona override signature** for glossary reflection — whether to thread
`glossary` as a standalone param or fold locale+glossary into one
`personaOverride` object passed to `defaultPersonaBlock`/`toPromptBlock`. Decided
in code review of Phase 2; does not change any locked product decision.
