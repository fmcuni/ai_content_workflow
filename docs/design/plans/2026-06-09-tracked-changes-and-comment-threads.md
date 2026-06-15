# Plan — Human tracked changes + review threads

**Spec:** `docs/design/specs/2026-06-09-tracked-changes-and-comment-threads.md`
**Date:** 2026-06-09
**Autonomy:** code + tests + commit on a feature branch. No push to main, no prod
migration push, no Worker deploy.

Two independently-mergeable phases. **Phase B (review threads) first** — fully
self-contained and does not touch the existing AI-to-edit pipeline. **Phase A
(tracked changes)** builds on Phase B's "Comment" anchor action.

> **Hard constraint:** the existing AI-to-edit pipeline (`Hitl2Comment`,
> `commentAnchor`, `useArticleComments`, `CommentsSidebar`, "AI to edit" tab,
> "Request AI to edit", `apply-edits`) is **not modified**. Feature B is additive.

## Phase B — Review threads (human-only comment / reply / resolve)

**Migration**
1. `supabase migration new review_threads` → `review_threads` table + index + RLS
   enable + `content_tool_app` grants (mirror `hitl2_snapshots`' RLS block).

**Backend — Python (`content_tool/`)**
2. `db/models.py`: `ReviewThread` model.
3. `models/`: Pydantic `ReviewMessage`, `ReviewThreadOut`, `CreateThreadIn`,
   `ReplyIn`, `ResolveIn`.
4. `api/routes/runs.py`: 5 routes (list/create/reply/resolve/delete). Author email
   + display name from the existing identity helper / session header. Mutate
   `messages` jsonb + `updated_at` immutably. On resolve/reopen + create, write a
   `run_event_logs` entry (reuse the existing event-log writer).

**Backend — Workers TS (`deploy/cloudflare-workers/`)**
5. `src/routes/runs.ts`: port the 5 routes (postgres.js); reuse `util/py_json.ts`
   for jsonb round-trip parity. Mirror the run-event audit write.
6. Route tests (`runs.test.ts` / `runs_rbac.test.ts`).

**Frontend (`web/`)**
7. `lib/types.ts`: `ReviewMessage`, `ReviewThread` (kept entirely separate from
   `Hitl2Comment`).
8. `lib/api.ts`: `listReviewThreads / createReviewThread / replyReviewThread /
   resolveReviewThread / deleteReviewThread`.
9. `lib/useReviewThreads.ts`: TanStack Query list + optimistic mutations,
   `["review-threads", runId]` invalidation. (New hook — does NOT replace
   `useArticleComments`, which stays for the AI path.)
10. `components/tiptap/ReviewAnchor.ts`: new mark (`data-review-id`, class
    `review-anchor`, distinct color; `resolved` attr → dim). Separate from
    `CommentAnchor`.
11. `components/TipTapEditor.tsx`: add a second selection action "Add review note"
    (alongside the existing AI "Comment" pill) → `onAddReviewNote(id, anchorText)`;
    click on a `data-review-id` span → `onReviewClick(id)`. New optional props;
    existing `onAddComment`/`onCommentClick` untouched.
12. `components/ReviewThreadList.tsx`: per-thread card — messages (name + initials
    `Avatar` + relative timestamp), reply box, Resolve/Reopen, Delete; open/
    resolved/all filter.
13. `components/run-editor/EditorRail.tsx`: add a "Review" tab (tabs become
    `wp | comments | review`) rendering `ReviewThreadList`. "AI to edit" tab kept
    verbatim.
14. `hitl2/page.tsx` + `edit/page.tsx`: wire `useReviewThreads` + the new editor
    props. Avatar via session display name; initials fallback.

**Tests**: Vitest for `useReviewThreads` optimistic reducer + `ReviewThreadList`
render/interactions; pytest + Workers route tests; parity gate.

## Phase A — Human tracked changes (commit / dismiss / comment)

**Migration**
15. `supabase migration new snapshot_committed_body` → nullable
    `committed_html_body` on `hitl2_snapshots`.

**Core (pure, testable)**
16. `web/lib/tracked-changes.ts`: `computeHunks(committed, working)`,
    `commitHunk(parts, i)`, `dismissHunk(parts, i)`, `commitAll`, `dismissAll`.
    Wraps `diffWords`; immutable; never splits a part. Vitest: empty / insert /
    delete / replace / multi-hunk / tag-boundary.

**Backend**
17. Add `committed_html_body` to snapshot DTO + model in **both** backends; persist;
    default to `html_body` when null on read. Verify PY↔TS sha parity helpers.

**Frontend**
18. `lib/run-editor/form.ts` + `useSnapshotAutosave.ts`: carry
    `committed_html_body`; include in the dirty key.
19. `components/TrackedChangesView.tsx`: render hunks with per-hunk
    Commit/Dismiss/Comment + Commit-all/Dismiss-all. "Comment" calls
    `useReviewThreads.createReviewThread` anchored to the hunk.
20. `hitl2/page.tsx` + `edit/page.tsx`: hold `committedHtml`; add "Tracked changes"
    galley tab (badge = pending hunk count). AI apply-edits sets
    `committedHtml = working = revised`. Commit-all writes a `run_event_logs`
    entry.

**Tests**: `tracked-changes.test.ts`; snapshot DTO round-trip (PY + Workers);
parity gate.

## Sequencing & gates

- Each phase = one feature branch, committed (not pushed). Migration files created
  but **not** pushed to prod.
- Per phase: `ruff check . && pyright` (no new errors over ~547 baseline);
  `cd web && npx tsc --noEmit && npm run lint && npx vitest run`; Workers
  `vitest run`; parity gate. Note if Docker-gated pytest can't run.
- `graphify update .` after code changes.

## Risk notes

- Word-level HTML diff cosmetics — accept parity with `HtmlDiffView`.
- Snapshot DTO change touches byte-identical PY↔TS serialization — verify
  `util/py_json.ts` sha parity.
- Optimistic thread mutations reconcile with server-returned `thread_id`/`anchor_id`.
- Two highlight mark types coexist — ensure `data-comment-id` (AI) and
  `data-review-id` (human) don't collide in parse/serialize or the strip helpers.
