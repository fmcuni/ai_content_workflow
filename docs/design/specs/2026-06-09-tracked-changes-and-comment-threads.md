# Spec — Human tracked changes + review threads on the article editor

**Date:** 2026-06-09
**Surface:** `/runs/{id}/hitl2` AND `/runs/{id}/edit` (the shared run-editor on the TipTap article body — both surfaces in scope)
**Status:** Revised per review — approved to build (commit on a branch)

## Problem

1. **No reviewable human edits.** When an editor changes the draft in TipTap, the
   change commits directly into the body. A second reviewer cannot see *what* a
   colleague changed and accept/reject it — only a read-only "Diff vs render" tab
   against the pristine AI render.
2. **No human-to-human review conversation.** The only highlight-comment system
   today is the **AI-edit instruction** channel (`Hitl2Comment`, "Request AI to
   edit"). There is no way for people to discuss a passage — comment, reply,
   resolve — without involving the AI.

## Goals

- **Feature A — Human tracked changes.** Human edits become *suggestions* the user
  is aware of: **commit** (accept), **dismiss** (revert), or attach a **further
  comment**. Diff-based, word-level, human-only. AI edits are out of scope.
- **Feature B — Review threads (NEW, separate pipeline).** A *second, independent*
  highlight type for **human-only** discussion: highlight → comment → **reply** →
  **resolve**. **Never dispatched to the AI.**

## Two parallel, independent pipelines — do not merge them

The existing **AI-to-edit** pipeline is good and stays **exactly as-is**:
- `Hitl2Comment = {id, anchor_text, body}`, the `commentAnchor` TipTap mark, the
  "Comment" selection pill, `useArticleComments`, `CommentsSidebar`, the "AI to
  edit" rail tab, the "Request AI to edit" button, and `apply-edits`. **Untouched.**

Feature B adds a **separate** annotation system that never touches the AI path:
- A new `reviewAnchor` TipTap mark (distinct color/class from `commentAnchor`).
- A separate "Review" rail surface with threaded discussion (reply/resolve).
- Its own persistence (dedicated table), its own selection action, its own state.
- No "send to AI", no apply-edits coupling. Human reply only.

So a highlighted passage can carry an AI-edit comment (yellow, existing) and/or a
review thread (a distinct color, new), independently.

## Non-goals

- Real-time keystroke suggestion mode (TipTap Pro). Feature A is a baseline-vs-
  working **diff layer** at word granularity.
- Tracking AI-generated edits as suggestions ("only for humans").
- Coupling review threads to AI editing in any way.
- Live multi-user cursors/presence.

## Feature A — design (unchanged from prior revision)

- A per-run **committed baseline** (`committed_html_body`) stored alongside the
  working body. No pending suggestions ⇒ `committed == working`.
- Human edits move working away from baseline. A **"Tracked changes"** galley tab
  diffs `committed` vs `working` (word-level, reusing the `diff` package behind
  `HtmlDiffView`) and renders each ins/del **hunk** with **Commit / Dismiss /
  Comment** (+ Commit-all / Dismiss-all).
  - *Commit* folds the hunk into baseline. *Dismiss* reverts working for that hunk.
  - *Comment* opens a Feature-B review thread anchored to the hunk.
- AI edits (`apply-edits`) write straight into baseline + working, so they never
  appear as pending hunks.

## Feature B — design (NEW human review threads)

### Data model — `content_tool.review_threads` (RLS; `content_tool_app` role)

| column | type | notes |
|---|---|---|
| `thread_id` | uuid PK | |
| `run_id` | uuid FK → runs(run_id) ON DELETE CASCADE | |
| `anchor_id` | varchar | matches `data-review-id` span in the body |
| `anchor_text` | varchar | quoted snippet for the rail |
| `status` | varchar NOT NULL DEFAULT 'open' | `'open' | 'resolved'` |
| `messages` | jsonb NOT NULL DEFAULT '[]' | `[{id, author_email, author_name, body, created_at}]` |
| `created_by` | varchar | author email |
| `created_by_name` | varchar | display name captured at write time |
| `created_at` | timestamptz DEFAULT now() | |
| `resolved_by` | varchar NULL | |
| `resolved_by_name` | varchar NULL | |
| `resolved_at` | timestamptz NULL | |
| `updated_at` | timestamptz DEFAULT now() | bumped on reply/resolve |

Index `review_threads_run_idx` on `(run_id, created_at)`. Replies inline as jsonb
(KISS; low volume; thread row owns status/anchor/resolve independent of snapshot
versions).

**Author display names + avatars** (requested): each message stores
`author_email` + `author_name` (denormalized from the better-auth session at write
time — no extra lookup table). The UI renders the name and an **initials avatar**
derived from the name/email. If the session exposes an avatar URL we pass it
through; otherwise initials.

### REST contract (both backends)

```
GET    /runs/{id}/review-threads                          → ReviewThread[]
POST   /runs/{id}/review-threads        {anchor_id, anchor_text, body}      → ReviewThread
POST   /runs/{id}/review-threads/{tid}/replies   {body}                     → ReviewThread
POST   /runs/{id}/review-threads/{tid}/resolve   {resolved: boolean}        → ReviewThread
DELETE /runs/{id}/review-threads/{tid}                                      → 204
```

Author identity from the authenticated session (`X-Editor-Email` / better-auth).
RBAC: create/reply/resolve = `edit_article` (viewer-as-content-editor model);
no new role.

### Audit / notification on resolve (requested)

On **resolve/reopen** (and on tracked-change **commit-all** / thread create), emit
a `run_event_logs` entry (the existing per-step debug/audit log) capturing actor +
thread id + action, so the run timeline records who resolved what and when. No push
notifications in this pass — the audit/event entry is the "notification" surface.

## Frontend surfaces (both `/hitl2` and `/edit`)

- `reviewAnchor` mark + a distinct selection action ("Add review note") alongside
  the existing AI "Comment" pill.
- A "Review" rail tab/section: `ReviewThreadList` (per-thread card: messages with
  name+avatar+timestamp, reply box, Resolve/Reopen, Delete, open/resolved/all
  filter). Clicking a thread focuses its anchor in the editor.
- "Tracked changes" galley tab (Feature A) with a pending-hunk-count badge.
- All shared via the existing run-editor components so `/hitl2` and `/edit` stay in
  lockstep.

## Acceptance criteria

### Feature A
- "Tracked changes" tab shows pending human edits as ins/del hunks when
  `working != committed`; "No pending changes" otherwise.
- Per-hunk Commit/Dismiss/Comment + Commit-all/Dismiss-all.
- Commit/Dismiss are pure immutable transforms over diff parts (unit-tested); never
  corrupt HTML.
- Committed baseline persists in the snapshot and survives reload/hand-off.
- AI apply-edits advances the baseline (no false pending hunks).

### Feature B
- Highlighting + "Add review note" creates a persisted **open** thread with the
  first message; the span carries `data-review-id`.
- Thread shows messages (name + initials avatar + timestamp), reply box,
  Resolve/Reopen, Delete; open/resolved/all filter; resolved highlights dim.
- Replies + resolve/reopen persist with author email/name + timestamp.
- **No AI coupling** — review threads are never sent to apply-edits.
- The existing AI-to-edit pipeline still works unchanged.
- Resolve/reopen writes a `run_event_logs` audit entry.
- Both `/hitl2` and `/edit` have the feature.

## Out-of-scope / limitations

- Word-level HTML diff can cosmetically split tags (parity with `HtmlDiffView`);
  commit/dismiss operate on whole diff parts so rejoined HTML stays valid.
- Concurrent suggestion editing by two people = last-writer-wins on the body;
  threads themselves are append-safe.

## Parity & tests

- Python ↔ Workers route parity (`parity/check-parity.mjs`).
- Vitest: `tracked-changes.ts` pure transforms; `useReviewThreads` + thread list.
- pytest testcontainers + Workers route tests for `review-threads`.
- `supabase db reset` applies migrations locally before dependent code.
