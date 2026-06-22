# Voice Studio — Unsaved Draft Store, Cross-Prompt Reflection & Clearer Entrance

**Date:** 2026-06-22
**Status:** Spec — pending approval
**Author:** feature-dev (franco.ma)

## Problem

Three issues raised against `/voices/[slug]` (Voice Studio) and its `/voices` entry:

1. **Entrance is buried.** The way into Voice Studio is a tiny right-aligned
   `Open in Studio →` text link tucked inside the Press Workflow section of the
   `/voices` overview page (`web/app/voices/page.tsx:102–109`). It is easy to
   miss; there is no clear "this is how you get into the editor" affordance.

2. **Edits don't reflect across prompts.** Editing a partial (e.g.
   `persona_block`) does not show up in the prompts that include it until you
   save the partial and re-open the consumer. You cannot see the blast radius of
   an in-progress edit.

3. **Edits are lost on navigation and save is fragmented.** Each prompt editor
   holds an isolated `buffer` `useState` (`web/components/prompts/PromptEditor.tsx`).
   **Switching nodes wipes the buffer** — in-progress edits vanish. Saving is
   per-prompt (one SHA-locked `PUT` each); there is no way to make a coherent set
   of edits across several prompts/partials and commit them together.

## Current architecture (verified)

- **PromptEditor** is shared by two surfaces: the Studio inspector
  (`StudioInspector` → click node) and the standalone `/prompts/[id]` library
  page. State is local `useState` (`buffer`, `sha`, `activeRoute`, `noteInput`,
  …), reset by a `useEffect` keyed on `[templateId, voice]` — this is what wipes
  edits on node switch.
- **Save** = `PUT /api/prompts/templates/{id}?voice=` with `{ template,
  expected_sha256, note }`. SHA optimistic lock; 409 on conflict. No batch
  endpoint exists.
- **Voice config** (locale / glossary / source policy / publish target) is edited
  in `VoiceConfigInspector` panels, each with its own draft + save against the
  **personas** API — a different backend surface from prompts.
- **Preview / assembly** (Workers TS, mirrored in Python):
  - `assembleWithOverride(routeId, snap, { overrideName, overrideBody })`
    (`prompts/store.ts`) resolves `{{include:NAME}}` recursively, swapping **one**
    partial body. Used by the existing single-partial preview.
  - `substitutePreview(sql, text, overrides, view, voice, localeOverride?)`
    (`prompts/editor.ts`) fills the named blocks `{persona_block}`,
    `{today_date}`, `{source_policy_block}`, `{create_mode_block}`, then applies
    any other `overrides` keys.
  - **Locale** already has an end-to-end `localeOverride` param (live preview).
  - **Source policy** enters as the `{source_policy_block}` placeholder
    (`getPolicy(sql, voice).toPromptBlock()`); `substitutePreview` already honors
    a `source_policy_block` override key.
  - **Glossary** is rendered **inside** `{persona_block}` (`toPromptBlock` →
    `renderGlossary`), not as a standalone token. Reflecting a glossary draft
    therefore requires routing it through the persona-block render, the same way
    `localeOverride` already does.

## Locked decisions (interview 2026-06-22)

1. **Entrance (Q1):** Replace the buried link with a dedicated **entry band
   directly below the Rolodex** on `/voices`, *before* the Style Card: kicker
   label + one-line description of what Studio does + a primary CTA
   **`Open {selected-voice} in Studio →`** that reflects the Rolodex selection.
   The Style Card and Press Workflow remain below.

2. **Scope (Q2):** Draft store, cross-reflection, and Save-all apply **only inside
   Voice Studio**. The standalone `/prompts/[id]` library page is **unchanged**
   (keeps isolated buffer + per-prompt save). Implemented as a Studio-level draft
   context that the shared editors read **when present**, falling back to today's
   isolated behavior otherwise.

3. **Reflection (Q3):** Generalize single-override assembly → **multi-override**.
   Any consumer agent's "Edit & assemble" preview slots in **all** the operator's
   unsaved partial drafts at once (today only the one partial being edited). No
   canvas blast-radius badges (possible follow-up).

4. **Draft lifetime (Q4):** **In-memory, per Studio session.** Drafts survive
   node / tab / mode switches for the current voice; cleared on full page reload
   or leaving the voice. A visible **"N unsaved" indicator** in the Studio header.
   No localStorage (avoids stale-draft / SHA-merge complexity).

5. **Save model (Q5):** **Unified "Save all · N".** Both the in-editor save
   button and a Studio-header action trigger the same global commit. No
   per-prompt-only save inside Studio.

6. **Failure handling (Q6):** Client-side **pre-validation gate** first — block
   Save-all and jump to any draft with a missing required placeholder or a body
   over the 64 KiB cap, before any network call. Then save **sequentially** via
   the existing endpoints, with **honest per-item reporting**
   ("Saved 3 of 4 · 1 conflict"). Successful items stay saved; failed/conflicted
   items stay dirty and flagged for reload-merge. **No false atomicity** (no new
   transactional endpoint).

7. **Save scope (Q7):** Save-all commits **everything dirty in Studio** —
   prompt/partial drafts (`PUT`s) **and** dirty voice-config panels (persona
   `PATCH` / source-policy / publish-target writes). The unified draft store holds
   both prompt buffers and config drafts; the save loop dispatches to the correct
   API per item; per-item reporting spans both.

8. **Changelog note (Q8):** A **single optional batch note** in the Save-all flow,
   stamped on each prompt/partial history entry committed in that batch. Config
   writes ignore the note (no note concept there).

9. **Loss guard (Q9):** When drafts exist, intercept **both** in-app navigation
   (leaving / switching voice) **and** browser reload/close (`beforeunload`) with
   a confirm. Save-all (full success) clears the guard.

10. **Config reflection (Q10):** **All assembly-touching config reflects live** in
    previews while unsaved — locale (existing), **source policy**, and
    **glossary**. Each needs an override path into the assembly engine on both
    backends (see Design).

### Minor defaults (assumed unless changed)
- **Discard:** "Discard all" in the unsaved indicator + per-node "revert this
  draft" in the editor.
- **Parity:** implement in the **Workers TS** backend (prod path) and mirror in
  the **Python** backend per project convention.
- **Design language:** reuse existing tokens / editorial "Style Sheet" tone. The
  Save-all + unsaved surface lives in the persistent Studio toolbar beside the
  mode selector and run dropdown — quiet until dirty, then a clear amber count +
  primary Save all.

## Design

### A. Entry band (`/voices`)
A presentational `StudioEntryBand` rendered between the Rolodex and the Style
Card. Reads the currently selected voice (`selectedSlug`) and links to
`/voices/{slug}`. No new data fetching. Remove the inline `Open in Studio →`
link from the Press Workflow section.

### B. Studio draft store (Voice Studio only)
A React context `StudioDraftProvider` mounted by the `/voices/[slug]` page, keyed
by the route's `voice`. Holds:

```ts
type ConfigDraftKind = "locale" | "glossary" | "source_policy" | "publish_target";

interface StudioDraftState {
  prompts: Map<string /* templateId */, { body: string; baseSha: string }>;
  config: Partial<Record<ConfigDraftKind, unknown /* typed per kind */>>;
  // derived: dirtyPromptIds, dirtyConfigKinds, unsavedCount
}
```

- **Prompt editors** read their draft from the store when a draft exists, else
  seed from the server template (today's behavior). Edits write to the store
  instead of a local-only buffer. `baseSha` is captured at first edit for the
  optimistic lock.
- **Config panels** write their drafts into `config` instead of panel-local
  state.
- **`unsavedCount`** = dirty prompts + dirty config kinds, surfaced in the header.
- Cleared on provider unmount (route change / reload) — matching the per-session
  decision.

A `useStudioDraft()` hook exposes read/write + derived dirty sets. When the
provider is **absent** (the `/prompts` library page), the editor falls back to
its current local `useState` path — zero behavior change there.

### C. Multi-override reflection (backend, both stacks)

1. **Partials → consumer previews.** Generalize the override from a single
   `{ overrideName, overrideBody }` to a **map**:
   ```ts
   assembleWithOverrides(routeId, snap, overrides: Map<string, string>)
   ```
   `resolveBodyWithOverride` becomes `resolveBodyWithOverrides`, consulting the
   map at each include. Python mirror in `content_tool/api/routes/prompts.py`.

2. **Preview request contract.** The `POST /templates/:id/preview` body gains
   optional draft inputs (all snake_case on the wire, all optional, absent ⇒
   byte-identical to today):
   - `partial_overrides: Record<string /* partial id */, string /* body */>` —
     the operator's other unsaved partial drafts.
   - `locale` — already supported.
   - `source_policy` — structured draft policy; backend renders it to the
     `{source_policy_block}` via the existing policy `toPromptBlock` path
     (reuse, do not hand-render on the client).
   - `glossary` — draft glossary entries; routed into `defaultPersonaBlock` /
     `toPromptBlock` as a persona override (mirrors how `localeOverride` is
     threaded), so the glossary section of `{persona_block}` reflects the draft.

   Validation: each is parsed/defaulted like `parsePreviewLocale` (non-object ⇒
   422); unknown overrides are ignored, not errored.

3. **Client.** When previewing a consumer, the editor sends the current draft
   map from the store (partials + any dirty locale/source-policy/glossary).
   Preview re-runs when *any* relevant draft changes, not just the focused
   buffer.

### D. Save-all
A `useSaveAll()` hook in the Studio layer:
1. **Pre-validate** every dirty prompt draft client-side (required placeholders
   present, ≤ 64 KiB). If any fail → abort, surface which node(s), select the
   first offender. No network call.
2. **Dispatch sequentially**, each item via its existing endpoint:
   - prompt/partial → `PUT /prompts/templates/{id}` with `{ body, expected_sha256:
     baseSha, note: batchNote }`.
   - config kinds → their existing persona / source-policy / publish-target
     writes (no note).
3. **Collect per-item results.** On success, update `baseSha`, clear that draft,
   invalidate its queries. On 409/error, keep the draft dirty + flag it.
4. **Report**: toast `Saved {ok} of {n}` + per-item status; conflicts get a
   "reload to merge" affordance. Loss-guard clears only when all dirty items
   committed.

The in-editor save button and the header action both call `useSaveAll()`.

### E. Loss guard
A `useUnsavedGuard(unsavedCount > 0)` hook: `beforeunload` listener for
reload/close + an in-app navigation intercept (Next router) for leaving/switching
voice. Confirm copy names the count.

## Out of scope
- Canvas blast-radius badges on consumer nodes (deferred).
- localStorage / cross-reload draft persistence.
- A transactional batch-save backend endpoint.
- Any change to `/prompts/[id]` library behavior.

## Testing
- **Backend (both stacks):** unit tests for `assembleWithOverrides` (multiple
  partials, nested includes, override precedence); preview route tests for
  `partial_overrides` / `source_policy` / `glossary` reflection; parity
  (TS ↔ Python byte-identical for the same inputs).
- **Web (vitest):** draft store reducer (dirty derivation, per-voice key reset);
  save-all (pre-validation gate, sequential dispatch, partial-failure reporting,
  baseSha update); loss guard. Component tests live in `.tsx`.
- **Self-verify:** deploy dev, drive via `scripts/claude-debug` (DEV-ONLY; HITL_2
  approve/publish remains network-guarded). Screenshot the entry band, an
  unsaved-draft reflection in a consumer preview, and a partial-failure Save-all
  toast.

## Risks
- **Whole-store preview latency:** sending many partial overrides on each preview
  is fine (debounced, server assembles in memory). Watch payload size vs the
  64 KiB-per-template reality (bounded).
- **Config reflection depth (Q10):** glossary/source-policy override plumbing is
  net-new on both backends; the persona-block glossary path is the fiddliest.
  Spec locks the approach (reuse `toPromptBlock` / policy `toPromptBlock`), but
  the exact persona-override signature is finalized in the plan.
- **Two-API save reporting:** mixing prompt `PUT`s and persona `PATCH`es in one
  result set — keep a discriminated result type so the UI can label each.
