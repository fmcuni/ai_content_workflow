# Spec — Real-time multi-editor collaboration + per-author attribution

- **Date:** 2026-06-09
- **Status:** PROPOSED (awaiting plan sign-off)
- **Owner:** franco.ma

## Problem

The same run / article is edited by several people. Today there is **no
real-time collaboration**: the run-editor surfaces (`/hitl2`, `/edit`,
`/regenerate`, read-only `/runs/[id]`) read and write the article body as a
plain HTML **string**, persisted via debounced snapshots
(`web/lib/run-editor/useSnapshotAutosave.ts` → Workers `runs.ts` snapshot
routes). Concurrent saves either **clobber** each other (last-write-wins) or one
editor gets a **`409 stale_version`** from the optimistic `expected_version`
guard and loses work.

The existing "Review changes" feature (`web/lib/tracked-changes.ts`,
`web/components/InlineTrackedChanges.tsx`) diffs a committed baseline HTML string
against the working HTML string. A string diff **cannot** represent "who typed
which character," especially under simultaneous editing — so per-keystroke
authorship is impossible in the current model.

## Goals

1. **Conflict-free simultaneous editing** of the article body across all
   run-editor surfaces — no clobbering, no `409` on the body.
2. **Live presence:** each connected editor's caret + name label is visible
   while they type.
3. **Per-keystroke authorship:** every character knows who inserted it; surfaced
   in the **Review-changes panel** popover (each `<ins>`/`<del>` hunk shows its
   author).
4. Preserve the current publish / version-history / compliance flow — the
   published artifact and the audit log are unchanged in shape.

## Non-goals

- Hover/colour author tint *inside the live editor* (explicitly out for v1 — the
  chosen blame surfaces are live cursors and the Review panel).
- Collaborative editing of run **metadata** (SEO title, meta description, WP
  author/category/slug/tags). v1 keeps those in form state; see "Phased rollout"
  for an optional follow-on that moves them into a shared `Y.Map`.
- Changing the LLM pipeline, the AI-edit ("Request AI to edit") flow, or the
  AI-baseline advance semantics.

## Why a CRDT (the core decision)

Per-keystroke authorship under concurrent editors requires an **authored
operation log**, not two HTML strings. We adopt **Yjs** (CRDT). The same move
that gives authorship also gives conflict-free concurrent editing and live
presence — one mechanism, three goals.

All libraries are **MIT / free**. We do **not** need TipTap Pro "Track Changes":
Yjs's built-in **`Y.PermanentUserData`** maps every character to the user who
inserted it. This matches the existing "no paid Pro extension" stance documented
in `tracked-changes.ts`.

## Architecture

| Concern | Mechanism |
|---|---|
| CRDT document + concurrent merge | **Yjs** `Y.Doc` (one per run) |
| ProseMirror ⇄ Yjs binding | `y-prosemirror` via `@tiptap/extension-collaboration` |
| Live cursors + name labels | `@tiptap/extension-collaboration-cursor` (awareness) |
| Per-character authorship | `Y.PermanentUserData` |
| Sync backend | New **`RunDoc` Durable Object** on the backend Worker, hibernatable WebSocket, Yjs update log in DO storage |
| Cold store / backup | Postgres `run_collab_state` (binary Yjs update) + existing HTML snapshots for version history & publish |
| Editor identity | better-auth session / `X-Editor-Email` → awareness user `{ email, name, colour }` and `PermanentUserData` key |

### Data flow

```
Browser A ─┐                         ┌─ Browser B
  TipTap   │   WebSocket (Yjs sync)   │   TipTap
  + Collab ├──────────►  RunDoc DO  ◄─┤   + Collab
  + Cursor │            (per run_id)  │   + Cursor
           │   awareness (cursors)    │
           └─────────────┬────────────┘
                         │ debounced flatten
                         ▼
              Yjs → HTML  ──►  snapshot / publish / version history
                         │
                         ▼
              Postgres run_collab_state (binary, cold start + backup)
```

- **Source of truth (live):** the Yjs doc in the `RunDoc` DO. HTML is *derived*,
  not authoritative, while editing is live.
- **Seeding:** when a run first reaches HITL_2, the DO seeds its empty Yjs doc
  **once** (idempotent) from the generated draft HTML.
- **Flatten:** on snapshot/save/approve, the current Yjs doc is flattened to HTML
  for the existing snapshot/version-history/publish pipeline (unchanged
  downstream).
- **Schema fidelity (critical):** the Yjs/ProseMirror doc MUST use the **exact
  same TipTap schema/extensions** as today — including the custom **`FaqAccordion`
  node** (`web/components/tiptap/`) and tables/links — or content corrupts on
  round-trip. This is the same class of bug as the FAQ-widget flattening issue.

### Authorship → Review panel

The committed-baseline → working diff (`computeTrackedChanges`) stays. For each
inserted hunk, we map the hunk's working-document position range to its author
via `Y.PermanentUserData`, attaching an `author` to the `Hunk`. The
`InlineTrackedChanges` popover renders "Added by {name}". Deletions are
attributed to the deleter when available.

## Identity, auth & RBAC

- The WebSocket handshake authenticates with the existing better-auth session
  (same gate as SSE; honour `FRONTEND_ORIGIN` / CORS as `RunStream` does).
- Awareness user = `{ email, name, colour }` derived from the session
  (`X-Editor-Email` already plumbed via the per-user editor identity work).
- RBAC unchanged: `viewer` (content-editor) and `editor`/`admin` may join and
  edit body; **create / regenerate / decide-HITL / publish remain gated** server
  side exactly as today. The DO rejects writes from roles below content-editor.

## Coexistence with current model

- **Optimistic `expected_version` 409** stops applying to the **body** (Yjs
  merges instead). It is retained for **metadata** PATCH/PUT until/unless metadata
  moves into the shared `Y.Map`.
- **`RunStream` DO** (pipeline SSE) and **`RunDoc` DO** (editor collab) are
  separate objects with separate lifecycles.
- **Local dev:** the DO runs under `wrangler dev`; the Python backend is not in
  the collab path. Web connects to the backend Worker's WS endpoint.

## Risks

| Risk | Mitigation |
|---|---|
| Yjs→HTML fidelity (FAQ node, tables, links) | Reuse identical TipTap schema; round-trip fixture tests against existing render output before cutover |
| WebSocket through the two-Worker split | Collab WS targets the **backend** Worker (DO host), not the OpenNext web Worker; mirror the SSE CORS/origin handling |
| Presence leak on disconnect/hibernation | Clear awareness on WS close; DO alarm sweeps stale awareness |
| DO storage growth (update log) | Periodic compaction to a single state vector + Postgres cold store |
| Publish reads stale HTML | Flatten-on-approve reads the live Yjs doc, not the last snapshot |

## Acceptance criteria

1. Two browsers editing the same run see each other's cursors + names and merge
   keystrokes with no lost characters and no `409`.
2. After concurrent edits, the Review-changes panel attributes each hunk to the
   correct author.
3. HITL_2 approve publishes HTML byte-equivalent to what the editor shows
   (including FAQ accordion / tables / links).
4. Version-history snapshots and compliance export are unchanged in shape.
5. All run-editor surfaces (`/hitl2`, `/edit`, `/regenerate`, read-only
   `/runs/[id]`) share the collaborative editor.

## Decisions (locked 2026-06-09)

- **Run metadata** (SEO title / meta description / WP author / category / slug /
  tags) stays **last-write-wins** in v1 — only the article **body** is
  collaborative. (Shared-`Y.Map` metadata is the optional follow-on.)
- **Cursor colours are server-issued per session** — the `RunDoc` DO assigns a
  colour on WebSocket connect (from a fixed palette, round-robin / least-used)
  and hands it back in the awareness user; clients never self-pick.
