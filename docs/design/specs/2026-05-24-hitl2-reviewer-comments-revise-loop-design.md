# HITL2 reviewer comments + AI revise loop

**Date:** 2026-05-24
**Status:** Draft for review

## Goal

Enable the editor reviewing a draft at HITL2 to (a) attach **anchored comments** to specific spans of the article and (b) write an **overall comment**, then submit those via the existing "Request changes" button. The AI re-drafts the article addressing those comments. The reviewer lands back on the same HITL2 page seeing the new version and can iterate. The loop is capped at **3 revision rounds** per run.

Today, "Request changes" persists state but the graph terminates without re-drafting — see [content_tool/graph/root.py:31-33](../../../content_tool/graph/root.py). Reviewer notes have nowhere to be entered in the UI, even though `Hitl2Request.notes` exists in the schema.

## Non-goals

- **No threaded discussions / replies** on comments. Each comment is a single message.
- **No comment persistence across rounds.** Each revision round starts with a clean slate; the previous round's comments presumably got addressed.
- **No per-edit diff review.** Reviewer sees the new full draft, not a list of suggested patches.
- **No configurable cap.** Hard-coded to 3 (revisit once we have data).

## Architecture

### Graph topology change

```
Today:  START → strategy → production → [HITL2] → publish → END
                                          │
                                          └─ if !approve → END (rejected | changes_requested)

After:  START → strategy → production → [HITL2] → publish_or_revise
                              ↑                       │
                              │  request_changes      ├─ approve → publish path → END
                              └───────────────────────┤  reject  → END
                              (resets production       └─ request_changes:
                               iteration counter,           round < 3 → production
                               feeds reviewer                round ≥ 3 → END (cap)
                               comments into
                               writer's refine_notes)
```

**Key reuse:** `n_writer` in [content_tool/graph/production.py:23](../../../content_tool/graph/production.py) already consumes a `refine_notes: list[dict]` parameter today (fed by audit findings). We extend the builder to also pull in reviewer comments and the overall note, translated into the same shape. No new prompt, no new agent.

### Components

| Layer | Component | Change |
|---|---|---|
| Frontend | `components/TipTapEditor.tsx` | Add custom `commentAnchor` mark, floating "Comment" pill on selection, expose `onCommentsChange` |
| Frontend | `components/CommentsSidebar.tsx` (new) | List comments anchored to current draft; textarea per comment; delete; click-to-focus |
| Frontend | `app/runs/[runId]/hitl2/page.tsx` | Right-rail tab switcher (WP metadata ↔ Comments); "Notes to AI" textarea above action bar; "Round N of 3" badge; disable Request changes at cap |
| Frontend | `lib/types.ts` | `Hitl2Comment` interface; extend `Hitl2Request`; `RunSummary.hitl_2_iteration: number` |
| Backend | `api/schemas.py` | `Hitl2Comment` model; extend `Hitl2Request`; expose `hitl_2_iteration` in `RunSummary` |
| Backend | `api/routes/runs.py` | Extend HITL2 handler — persist comments + iteration, 409 at cap, route via state |
| Backend | `graph/root.py` | Rename node to `n_publish_or_revise`; conditional edge back to production |
| Backend | `graph/production.py` | Merge reviewer comments into `refine_notes` in `n_writer` |
| Backend | `models/state.py` | Add `hitl_2_comments`, `hitl_2_iteration` to `ContentToolState` |
| Backend | `db/models.py` | Add `hitl_2_comments` JSONB, `hitl_2_iteration` Integer columns on `Run` |
| Backend | `utils/html_comments.py` (new) | `strip_comment_anchors(html)` — drops `data-comment-id` attrs before HTML lands in `Draft` rows or WP |
| Migrations | new Alembic revision | Two `ALTER TABLE` statements, no backfill |

### Data shapes

**`Hitl2Comment`** (Pydantic + matching TS type):
```python
class Hitl2Comment(BaseModel):
    id: str                  # client-generated UUID
    anchor_text: str         # first 120 chars max of the highlighted span, used by the LLM
    body: str                # reviewer's comment
```

**Extended `Hitl2Request`:**
```python
class Hitl2Request(BaseModel):
    decision: Literal["approve", "request_changes", "reject"]
    notes: str | None = None
    comments: list[Hitl2Comment] | None = None   # NEW
    # ... existing fields unchanged
```

**Submit payload example** (on "Request changes"):
```jsonc
{
  "decision": "request_changes",
  "notes": "The lede should be punchier — lead with the surgery question, not the symptoms.",
  "comments": [
    { "id": "c-3f2a", "anchor_text": "膝蓋「噗」一聲", "body": "Add audio cue — what does it sound like?" },
    { "id": "c-91bd", "anchor_text": "膝關節劇烈疼痛",  "body": "Pain scale unclear — quantify it?" }
  ],
  "edited_html_body": "<...html with <span data-comment-id='c-3f2a'>...</span>...>",
  // ...existing wp_* fields preserved
}
```

The backend strips `data-comment-id` attributes from the HTML before persisting to the next `Draft` and before any WP push.

### Reviewer-comment → refine-note translation

In `n_writer` ([content_tool/graph/production.py:23](../../../content_tool/graph/production.py#L23)):

```python
refine_notes: list[dict] = []

# (existing) audit-driven notes from prior iteration
if state["iteration"] > 0 and state["audit_findings"]:
    refine_notes.extend(
        f for f in state["audit_findings"]["findings"]
        if f.get("must_fix") or f.get("severity") == "high"
    )

# (new) reviewer-driven notes from HITL2
if state.get("hitl_2_iteration", 0) > 0:
    for c in state.get("hitl_2_comments") or []:
        refine_notes.append({
            "source": "reviewer",
            "severity": "high",
            "must_fix": True,
            "issue": f'On span "{c["anchor_text"]}": {c["body"]}',
        })
    if state.get("hitl_2_notes"):
        refine_notes.append({
            "source": "reviewer-overall",
            "severity": "high",
            "must_fix": True,
            "issue": f"Overall reviewer note: {state['hitl_2_notes']}",
        })
```

### `n_publish_or_revise` and routing

In `content_tool/graph/root.py`:

```python
async def n_publish_or_revise(state):
    decision = state.get("hitl_2_decision")
    if decision == "approve":
        # existing publish_to_wordpress + write_compliance_log logic
        return {"status": "published"}
    if decision == "reject":
        return {"status": "rejected"}
    # decision == "request_changes"
    if state.get("hitl_2_iteration", 0) >= 3:
        return {"status": "changes_requested"}  # cap reached, terminal
    return {
        "status": "revising",
        "iteration": 0,
        "writer_output": None,
        "render": None,
        "audit_findings": None,
    }

def route_after_publish_or_revise(state):
    return "production" if state.get("status") == "revising" else END

root.add_conditional_edges(
    "publish_or_revise",
    route_after_publish_or_revise,
    {"production": "production", END: END},
)
```

`interrupt_before=["production", "publish_or_revise"]` (rename only). HITL2 still gates on entry to the publish/revise node.

### UI placement decisions

- **Comments panel:** right-column **tab switcher** — WP metadata ↔ Comments. Tab labels small; switcher consumes ~30px header on the right column.
- **"Notes to AI" textarea:** full-width inside the editor column, *above* the sticky action bar. Always visible, no toggle. ~3 rows default, autosizes to ~8.
- **Round badge:** small chip in the sticky action bar, left of the buttons: `Round 1 of 3`.
- **"Request changes" disabled at cap:** button disabled with a tooltip `Cap reached — approve or reject.`

## Edge cases

- **Orphaned comment** (reviewer deletes a commented span): drop from payload client-side (comment id not present in any `data-comment-id`).
- **Cap race** (two tabs): UI disables, backend returns `409` on the second submit; toast surfaces the message.
- **Resume mid-revision** (runner crash): LangGraph checkpointer resumes from the last node; each production node is idempotent at the row level (new `Draft` per iteration).
- **`request_changes` with empty comments and empty notes:** frontend disables button; backend allows (harmless no-op refine).
- **`data-comment-id` leakage:** `strip_comment_anchors` runs before HTML lands in any persisted `Draft` row or WP request body.
- **Approve while comments exist:** ignored; publish proceeds.

## Testing strategy

| Layer | Test type | Coverage |
|---|---|---|
| `Hitl2Comment` schema | pytest unit | Required fields, anchor_text length bound |
| `POST /runs/{id}/hitl-2` | pytest async/httpx | All decisions; 409 at cap; persists comments + iteration |
| `n_publish_or_revise` + routing | pytest with LangGraph in-memory checkpointer | Three decisions; cap → terminal; resets production state on revising |
| `n_writer` refine_notes merge | pytest | Reviewer-only, audit-only, combined; correct shape |
| `strip_comment_anchors` | pytest unit | Single mark, nested, malformed HTML |
| TipTap `commentAnchor` + sidebar | Playwright | Selection → pill → sidebar entry; round badge updates; cap disables button |
| End-to-end happy path | Playwright (mocked Gemini) | Comment + note → request_changes → new draft visible at HITL2 |

## Migration

New Alembic revision: add `hitl_2_comments JSONB` and `hitl_2_iteration INTEGER NOT NULL DEFAULT 0` to `runs`. No backfill — defaults match historical "never requested changes" semantics.

## Open questions (none blocking)

- Should orphaned comments be surfaced in the UI as a warning before submit, or silently dropped? (Default: silently dropped — keeps the reviewer focused on the live ones.)
- Should the round badge appear at round 0, or only after the first revision? (Default: show only at round ≥ 1 — round 0 is "first review", not "first revision".)
