# HITL2 Reviewer Comments + AI Revise Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture reviewer comments (anchored + overall) at HITL2, feed them into the existing `production` sub-graph's `refine_notes` channel, and loop the reviewer back to HITL2 after each AI revision. Capped at 3 rounds.

**Architecture:** Two new `Run` columns (`hitl_2_comments` JSONB, `hitl_2_iteration` Integer). The graph's `publish` node becomes `publish_or_revise` with a conditional edge back to `production`. `n_writer` already takes `refine_notes` — we widen the source. Frontend adds a custom TipTap `commentAnchor` mark, a comments sidebar (tab-switcher with WP metadata in the right rail), a "Notes to AI" textarea, and a round-counter badge.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, LangGraph, Pydantic v2, Next.js 16, React 19, TipTap 3, Tailwind v4.

---

## Task 1: DB migration + Run model columns

**Files:**
- Create: `alembic/versions/0008_hitl2_comments_iteration.py`
- Modify: `content_tool/db/models.py:67-68` (add two columns next to existing `hitl_2_decision` / `hitl_2_notes`)

- [ ] **Step 1: Create Alembic migration**

Create `alembic/versions/0008_hitl2_comments_iteration.py`:

```python
"""hitl2_comments_iteration

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-24
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade() -> None:
    op.add_column(
        "runs",
        sa.Column("hitl_2_comments", postgresql.JSONB(), nullable=True),
        schema="content_tool",
    )
    op.add_column(
        "runs",
        sa.Column(
            "hitl_2_iteration",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_column("runs", "hitl_2_iteration", schema="content_tool")
    op.drop_column("runs", "hitl_2_comments", schema="content_tool")
```

- [ ] **Step 2: Add columns to `Run` model**

Modify `content_tool/db/models.py` — add two lines just after `hitl_2_notes` at line 68:

```python
    hitl_2_decision: Mapped[str | None] = mapped_column(String)
    hitl_2_notes: Mapped[str | None] = mapped_column(String)
    hitl_2_comments: Mapped[list | None] = mapped_column(JSONB)
    hitl_2_iteration: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
```

(`Integer` and `text` are already imported at the top of the file.)

- [ ] **Step 3: Apply the migration locally**

Run:
```bash
cd /Users/franco.ma/Documents/App/ai_content_tool_2 && .venv/bin/alembic upgrade head
```

Expected: `INFO [alembic.runtime.migration] Running upgrade 0007 -> 0008, hitl2_comments_iteration`

- [ ] **Step 4: Commit**

```bash
git add alembic/versions/0008_hitl2_comments_iteration.py content_tool/db/models.py
git commit -m "feat(db): add hitl_2_comments + hitl_2_iteration columns"
```

---

## Task 2: Extend ContentToolState + Pydantic schemas

**Files:**
- Modify: `content_tool/models/state.py:40` (add two fields)
- Modify: `content_tool/api/schemas.py:37-50` (Hitl2Comment + extend Hitl2Request; expose `hitl_2_iteration` in `RunSummary`)

- [ ] **Step 1: Add state fields**

Modify `content_tool/models/state.py`. Locate the `ContentToolState` TypedDict and add two fields next to the existing `hitl_2_decision`:

```python
    hitl_2_decision: str | None
    hitl_2_notes: str | None
    hitl_2_comments: list[dict] | None
    hitl_2_iteration: int
```

If `hitl_2_notes` doesn't exist there yet, add it too.

- [ ] **Step 2: Add Hitl2Comment + extend Hitl2Request**

In `content_tool/api/schemas.py`, just above `class Hitl2Request`:

```python
class Hitl2Comment(BaseModel):
    id: str
    anchor_text: str = Field(max_length=120)
    body: str
```

Add `comments` field to `Hitl2Request`:

```python
class Hitl2Request(BaseModel):
    decision: Literal["approve", "request_changes", "reject"]
    notes: str | None = None
    comments: list[Hitl2Comment] | None = None
    edited_html_body: str | None = None
    # ... rest unchanged
```

Make sure `Field` is imported from `pydantic`.

- [ ] **Step 3: Expose `hitl_2_iteration` in RunSummary**

Locate `RunSummary` in `content_tool/api/schemas.py:21` and add the field:

```python
class RunSummary(BaseModel):
    run_id: UUID
    status: str
    created_at: datetime
    article_id: UUID | None = None
    hitl_2_iteration: int = 0
```

Then find the route handler that builds `RunSummary` (search `RunSummary(` in `content_tool/api/routes/`) and pass `hitl_2_iteration=row.hitl_2_iteration` when constructing it. Likely in `content_tool/api/routes/runs.py`.

- [ ] **Step 4: Commit**

```bash
git add content_tool/models/state.py content_tool/api/schemas.py content_tool/api/routes/runs.py
git commit -m "feat(api): Hitl2Comment schema + hitl_2_iteration exposure"
```

---

## Task 3: HTML sanitization utility (`strip_comment_anchors`)

**Files:**
- Create: `content_tool/utils/html_comments.py`
- Create: `tests/unit/test_html_comments.py`
- Create: `content_tool/utils/__init__.py` if it doesn't exist

- [ ] **Step 1: Write the failing test**

Create `tests/unit/test_html_comments.py`:

```python
from content_tool.utils.html_comments import strip_comment_anchors


def test_strips_single_mark():
    html = '<p>foo <span data-comment-id="abc">bar</span> baz</p>'
    assert strip_comment_anchors(html) == '<p>foo bar baz</p>'


def test_strips_nested_marks():
    html = '<p><span data-comment-id="a">x <span data-comment-id="b">y</span></span></p>'
    assert strip_comment_anchors(html) == '<p>x y</p>'


def test_preserves_other_attributes_and_other_spans():
    html = '<p><span class="kept">x</span><span data-comment-id="a">y</span></p>'
    assert strip_comment_anchors(html) == '<p><span class="kept">x</span>y</p>'


def test_idempotent_on_clean_html():
    html = '<p>hello <strong>world</strong></p>'
    assert strip_comment_anchors(html) == html


def test_malformed_html_does_not_crash():
    html = '<p>oops<span data-comment-id="x">no close'
    out = strip_comment_anchors(html)
    assert "data-comment-id" not in out
```

- [ ] **Step 2: Verify it fails**

```bash
cd /Users/franco.ma/Documents/App/ai_content_tool_2 && .venv/bin/pytest tests/unit/test_html_comments.py -v
```

Expected: `ModuleNotFoundError: No module named 'content_tool.utils.html_comments'`

- [ ] **Step 3: Implement**

Ensure `content_tool/utils/__init__.py` exists (empty file). Create `content_tool/utils/html_comments.py`:

```python
from bs4 import BeautifulSoup


def strip_comment_anchors(html: str) -> str:
    """Remove <span data-comment-id="..."> wrappers, keeping their inner content.

    Used to clean reviewer-comment markup before HTML is persisted to a Draft
    row or sent to WordPress. Other spans and attributes are preserved.
    """
    soup = BeautifulSoup(html, "html.parser")
    for span in soup.find_all("span", attrs={"data-comment-id": True}):
        span.unwrap()
    return str(soup)
```

- [ ] **Step 4: Verify it passes**

```bash
.venv/bin/pytest tests/unit/test_html_comments.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add content_tool/utils/html_comments.py content_tool/utils/__init__.py tests/unit/test_html_comments.py
git commit -m "feat(utils): strip_comment_anchors for reviewer-comment HTML"
```

---

## Task 4: Extend the HITL2 API handler

**Files:**
- Modify: `content_tool/api/routes/runs.py:207-239` (the `hitl_2` route)

- [ ] **Step 1: Update the handler**

Replace the handler body with:

```python
@router.post("/{run_id}/hitl-2")
async def hitl_2(
    run_id: UUID, payload: Hitl2Request,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> dict:
    from sqlalchemy import update, select

    async with sf() as session:
        row = (
            await session.execute(select(Run).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "run not found")

        # Cap defense (UI also disables — this is belt + braces)
        if payload.decision == "request_changes" and row.hitl_2_iteration >= 3:
            raise HTTPException(409, "request_changes cap reached")

        new_iteration = (
            row.hitl_2_iteration + 1
            if payload.decision == "request_changes"
            else row.hitl_2_iteration
        )

        await session.execute(
            update(Run).where(Run.run_id == run_id).values(
                hitl_2_decision=payload.decision,
                hitl_2_notes=payload.notes,
                hitl_2_comments=[c.model_dump() for c in (payload.comments or [])],
                hitl_2_iteration=new_iteration,
                approved_at=datetime.now(UTC) if payload.decision == "approve" else None,
                approved_by="placeholder-editor",
                wp_publish_status=payload.wp_publish_status,
                wp_author_id=payload.wp_author_id,
                wp_category_ids=payload.wp_category_ids,
                wp_tag_ids=payload.wp_tag_ids,
                wp_featured_media_id=payload.wp_featured_media_id,
                wp_slug=payload.wp_slug,
                wp_excerpt=payload.wp_excerpt,
                wp_publish_at=payload.wp_publish_at,
            )
        )
        await session.commit()

    state_update: dict = {
        "hitl_2_decision": payload.decision,
        "hitl_2_notes": payload.notes,
        "hitl_2_comments": [c.model_dump() for c in (payload.comments or [])],
        "hitl_2_iteration": new_iteration,
    }
    # request_changes no longer terminates — the graph routes to revising
    if payload.decision == "reject":
        state_update["status"] = "rejected"

    await runner.resume(run_id, state_update)
    return {"ok": True}
```

`Run` must be imported (it likely is). If not, add `from content_tool.db.models import Run` at the top.

- [ ] **Step 2: Commit**

```bash
git add content_tool/api/routes/runs.py
git commit -m "feat(api): persist hitl2 comments + iteration, enforce 3-round cap"
```

---

## Task 5: Graph rewire — `publish_or_revise` + revise loop

**Files:**
- Modify: `content_tool/graph/root.py`
- Modify: `content_tool/graph/production.py:23-48` (writer node) + `content_tool/api/sse.py:178` (tolerate "revising")

- [ ] **Step 1: Update `n_writer` to consume reviewer feedback**

In `content_tool/graph/production.py`, replace the existing `refine_notes` builder (lines 24-30) with:

```python
        refine_notes: list[dict] = []

        # Audit-driven notes from prior production iteration.
        if state["iteration"] > 0 and state["audit_findings"]:
            findings = state["audit_findings"].get("findings", [])
            refine_notes.extend(
                f for f in findings if f.get("must_fix") or f.get("severity") == "high"
            )

        # Reviewer-driven notes carried over from the HITL2 gate.
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

        refine_notes = refine_notes or None  # writer expects None or non-empty list
```

- [ ] **Step 2: Rewrite `root.py` for the revise loop**

Replace the whole `n_publish` and graph wiring with:

```python
    async def n_publish_or_revise(state: ContentToolState) -> dict[str, Any]:
        decision = state.get("hitl_2_decision")

        if decision == "approve":
            if wp_client is None:
                return {"status": "persisted", "error": {"message": "wp_client not configured"}}
            async with session_factory() as session:
                await publish_to_wordpress(
                    session=session,
                    run_id=UUID(state["run_id"]),
                    wp_client=wp_client,
                    seo_plugin=seo_plugin,  # type: ignore[arg-type]
                    if_unmodified_since=None,
                )
            settings = get_settings()
            cost_calc = CostCalculator.load_from("config/pricing.yaml")
            async with session_factory() as session:
                await write_compliance_log(
                    session=session,
                    run_id=UUID(state["run_id"]),
                    cost_calc=cost_calc,
                    gemini_model=settings.gemini_model,
                )
            return {"status": "published"}

        if decision == "reject":
            return {"status": "rejected"}

        # decision == "request_changes"
        if state.get("hitl_2_iteration", 0) >= 3:
            return {"status": "changes_requested"}  # cap reached, terminal

        # Reset production-internal counters so the audit loop has fresh budget.
        return {
            "status": "revising",
            "iteration": 0,
            "writer_output": None,
            "render": None,
            "audit_findings": None,
        }

    def route_after_publish_or_revise(state: ContentToolState) -> str:
        return "production" if state.get("status") == "revising" else END

    root = StateGraph(ContentToolState)
    root.add_node("strategy", strategy)
    root.add_node("production", production)
    root.add_node("publish_or_revise", n_publish_or_revise)
    root.add_edge(START, "strategy")
    root.add_edge("strategy", "production")
    root.add_edge("production", "publish_or_revise")
    root.add_conditional_edges(
        "publish_or_revise",
        route_after_publish_or_revise,
        {"production": "production", END: END},
    )

    return root.compile(
        checkpointer=checkpointer,
        interrupt_before=["production", "publish_or_revise"],
    )
```

- [ ] **Step 3: Update SSE terminal-status mirroring**

In `content_tool/api/sse.py:178`, extend the terminal status set:

```python
if final_status in ("rejected", "changes_requested", "revising", "published"):
    # "revising" should never be terminal — graph routes back to production —
    # but if the run halted at the boundary we still want the row to match
    # state. publish.py owns "published" otherwise.
    if final_status != "revising":
        await self._set_status(run_id, final_status)
```

(Adjust as needed — the original logic only handled rejected/changes_requested. The point: "revising" is **not** a terminal status that should be persisted; the run is continuing.)

- [ ] **Step 4: Smoke-run the existing graph tests**

```bash
.venv/bin/pytest tests/integration/test_root_graph_e2e.py tests/integration/test_production_refine_loop.py -v
```

Expected: existing tests still pass. If `n_publish` is referenced by name in tests, rename to `n_publish_or_revise` there.

- [ ] **Step 5: Commit**

```bash
git add content_tool/graph/root.py content_tool/graph/production.py content_tool/api/sse.py
git commit -m "feat(graph): publish_or_revise node + reviewer-comment refine loop"
```

---

## Task 6: Frontend types

**Files:**
- Modify: `web/lib/types.ts`

- [ ] **Step 1: Add Hitl2Comment + extend Hitl2Request + RunSummary**

In `web/lib/types.ts`:

```typescript
export interface Hitl2Comment {
  id: string;
  anchor_text: string;
  body: string;
}

export interface Hitl2Request {
  decision: "approve" | "request_changes" | "reject";
  notes?: string | null;
  comments?: Hitl2Comment[] | null;
  edited_html_body?: string | null;
  // ... existing fields unchanged
}
```

Locate the existing `RunSummary` interface and add:

```typescript
export interface RunSummary {
  // ... existing
  hitl_2_iteration: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/types.ts
git commit -m "feat(web): Hitl2Comment type + hitl_2_iteration on RunSummary"
```

---

## Task 7: Custom TipTap `commentAnchor` mark

**Files:**
- Create: `web/components/tiptap/CommentAnchor.ts`

- [ ] **Step 1: Implement the mark**

Create `web/components/tiptap/CommentAnchor.ts`:

```typescript
import { Mark, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentAnchor: {
      setCommentAnchor: (attributes: { commentId: string }) => ReturnType;
      unsetCommentAnchor: (commentId: string) => ReturnType;
    };
  }
}

export const CommentAnchor = Mark.create({
  name: "commentAnchor",

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-comment-id"),
        renderHTML: (attrs) => (attrs.commentId ? { "data-comment-id": attrs.commentId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "comment-anchor",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCommentAnchor:
        (attrs) =>
        ({ commands }) =>
          commands.setMark(this.name, attrs),
      unsetCommentAnchor:
        (commentId) =>
        ({ tr, state, dispatch }) => {
          let removed = false;
          state.doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type.name === this.name && mark.attrs.commentId === commentId) {
                tr.removeMark(pos, pos + node.nodeSize, mark);
                removed = true;
              }
            });
          });
          if (removed && dispatch) dispatch(tr);
          return removed;
        },
    };
  },
});
```

- [ ] **Step 2: Add the highlight style**

Append to `web/app/globals.css` (inside `@layer components`):

```css
  .editorial-prose .comment-anchor {
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
    border-bottom: 2px solid color-mix(in srgb, var(--color-accent) 50%, transparent);
    cursor: pointer;
    border-radius: 2px;
    padding: 0 1px;
  }
  .editorial-prose .comment-anchor[data-focus="true"] {
    background: color-mix(in srgb, var(--color-accent) 24%, transparent);
    border-bottom-color: var(--color-accent);
  }
```

- [ ] **Step 3: Commit**

```bash
git add web/components/tiptap/CommentAnchor.ts web/app/globals.css
git commit -m "feat(web): commentAnchor TipTap mark + highlight styling"
```

---

## Task 8: Comments sidebar component

**Files:**
- Create: `web/components/CommentsSidebar.tsx`

- [ ] **Step 1: Implement the sidebar**

Create `web/components/CommentsSidebar.tsx`:

```tsx
"use client";
import { useRef, useEffect } from "react";
import { Trash2 } from "lucide-react";
import type { Hitl2Comment } from "@/lib/types";

interface Props {
  comments: Hitl2Comment[];
  focusedId: string | null;
  onChange: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onFocus: (id: string) => void;
}

export function CommentsSidebar({ comments, focusedId, onChange, onDelete, onFocus }: Props) {
  const refs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  useEffect(() => {
    if (focusedId && refs.current[focusedId]) {
      refs.current[focusedId]!.focus();
      refs.current[focusedId]!.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focusedId]);

  if (comments.length === 0) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint px-1 py-3">
        No comments yet. Highlight text in the editor to add one.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {comments.map((c) => (
        <li
          key={c.id}
          className={`border border-rule rounded p-3 bg-paper transition-shadow ${
            focusedId === c.id ? "shadow-md border-accent/60" : ""
          }`}
          onClick={() => onFocus(c.id)}
        >
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint mb-2 line-clamp-2">
            "{c.anchor_text}"
          </p>
          <textarea
            ref={(el) => { refs.current[c.id] = el; }}
            value={c.body}
            onChange={(e) => onChange(c.id, e.target.value)}
            rows={2}
            placeholder="What needs to change?"
            className="w-full resize-y text-[13px] text-ink bg-transparent focus:outline-none border-b border-rule focus:border-accent pb-1"
          />
          <div className="flex justify-end mt-2">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
              className="text-ink-faint hover:text-accent-deep inline-flex items-center gap-1 text-[11px]"
              aria-label="Delete comment"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/CommentsSidebar.tsx
git commit -m "feat(web): CommentsSidebar component"
```

---

## Task 9: Extend `TipTapEditor` — selection pill + comments callback

**Files:**
- Modify: `web/components/TipTapEditor.tsx`

- [ ] **Step 1: Add props for comments + selection pill**

Replace the export of `TipTapEditor` with a version that:
- Accepts `comments: Hitl2Comment[]`, `onAddComment: (id, anchorText) => void`, `onCommentClick: (id) => void`
- Registers the `CommentAnchor` mark
- Shows a floating "💬 Comment" pill when the user has a non-empty text selection

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import {
  Bold as BoldIcon, Italic as ItalicIcon, Strikethrough,
  Heading2, Heading3, List, ListOrdered, Quote,
  Link as LinkIcon, Undo2, Redo2, MessageSquarePlus,
} from "lucide-react";
import { CommentAnchor } from "@/components/tiptap/CommentAnchor";
import { cn } from "@/lib/utils";
import type { Hitl2Comment } from "@/lib/types";
// ... keep existing ToolbarButton, Divider, Toolbar definitions

interface Props {
  value: string;
  onChange: (html: string) => void;
  onAddComment?: (id: string, anchorText: string) => void;
  onCommentClick?: (id: string) => void;
}

export function TipTapEditor({ value, onChange, onAddComment, onCommentClick }: Props) {
  const [selectionPill, setSelectionPill] = useState<{ x: number; y: number } | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      LinkExtension.configure({ openOnClick: false, autolink: true,
        HTMLAttributes: { class: "text-accent underline underline-offset-2" } }),
      CommentAnchor,
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      if (from === to || !onAddComment) {
        setSelectionPill(null);
        return;
      }
      // Position pill near the end of the selection
      const coords = editor.view.coordsAtPos(to);
      setSelectionPill({ x: coords.left, y: coords.top + 24 });
    },
    editorProps: {
      attributes: {
        class:
          "editorial-prose max-w-none min-h-[480px] focus:outline-none px-6 py-5 border border-rule rounded-b bg-paper",
      },
      handleClickOn: (_view, _pos, _node, _nodePos, event) => {
        const target = event.target as HTMLElement;
        const span = target.closest("[data-comment-id]");
        if (span && onCommentClick) {
          onCommentClick(span.getAttribute("data-comment-id")!);
          return true;
        }
        return false;
      },
    },
    immediatelyRender: false,
  });

  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  const addComment = useCallback(() => {
    if (!editor || !onAddComment) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const anchorText = editor.state.doc.textBetween(from, to, " ").slice(0, 120);
    const id = `c-${crypto.randomUUID().slice(0, 8)}`;
    editor.chain().focus().setCommentAnchor({ commentId: id }).run();
    onAddComment(id, anchorText);
    setSelectionPill(null);
  }, [editor, onAddComment]);

  if (!editor) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint animate-pulse">
        Loading editor…
      </p>
    );
  }

  return (
    <div className="relative">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      {selectionPill && onAddComment && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={addComment}
          style={{ position: "fixed", left: selectionPill.x, top: selectionPill.y, zIndex: 50 }}
          className="inline-flex items-center gap-1.5 rounded border border-ink bg-paper px-2.5 py-1 text-[12px] font-mono uppercase tracking-wider text-ink shadow-md hover:bg-ink hover:text-paper"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" /> Comment
        </button>
      )}
    </div>
  );
}
```

(Keep the existing `ToolbarButton`, `Divider`, `Toolbar` components — they don't change. The Toolbar can later get a "Comment" button too but is not strictly required since the floating pill covers it.)

- [ ] **Step 2: Commit**

```bash
git add web/components/TipTapEditor.tsx
git commit -m "feat(web): selection pill + comment-mark wiring on TipTapEditor"
```

---

## Task 10: Hitl2 page — full integration

**Files:**
- Modify: `web/app/runs/[runId]/hitl2/page.tsx`

- [ ] **Step 1: Add state, tab switcher, Notes-to-AI textarea, round badge, submit serialization**

Replace the page with the integrated version:

```tsx
"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionHead } from "@/components/SectionHead";
import { PaperStamp } from "@/components/PaperStamp";
import { TipTapEditor } from "@/components/TipTapEditor";
import { HtmlDiffView } from "@/components/HtmlDiffView";
import { WordPressMetaForm } from "@/components/WordPressMetaForm";
import { CommentsSidebar } from "@/components/CommentsSidebar";
import { api } from "@/lib/api";
import type { Hitl2Request, Hitl2Comment } from "@/lib/types";

const MAX_ROUNDS = 3;

export default function Hitl2Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();

  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });
  const audit = useQuery({ queryKey: ["audit", runId], queryFn: () => api.getLatestAudit(runId) });
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId) });

  const [html, setHtml] = useState<string>("");
  const [form, setForm] = useState<Hitl2Request>({ decision: "approve", wp_publish_status: "draft" });
  const [originalHtml, setOriginalHtml] = useState("");
  const [comments, setComments] = useState<Hitl2Comment[]>([]);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);

  useEffect(() => {
    if (render.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHtml(render.data.html_body);
      setOriginalHtml(render.data.html_body);
      setForm((f) => ({
        ...f,
        edited_seo_title: render.data!.seo_title,
        edited_meta_description: render.data!.meta_description,
        wp_excerpt: render.data!.excerpt_suggestion,
      }));
    }
  }, [render.data]);

  const renderReady = Boolean(render.data);
  const round = run.data?.hitl_2_iteration ?? 0;
  const capReached = round >= MAX_ROUNDS;
  const hasFeedback = comments.some((c) => c.body.trim().length > 0) || (form.notes ?? "").trim().length > 0;

  const submit = useMutation({
    mutationFn: (decision: Hitl2Request["decision"]) => {
      // Filter orphans — comments whose mark no longer exists in the HTML
      const liveComments = decision === "request_changes"
        ? comments.filter((c) => html.includes(`data-comment-id="${c.id}"`))
        : [];
      return api.resumeHitl2(runId, {
        ...form,
        decision,
        edited_html_body: html,
        comments: liveComments,
      });
    },
    onSuccess: () => router.push(`/runs/${runId}`),
    onError: (e: Error) => toast.error(e.message),
  });

  const addComment = (id: string, anchorText: string) => {
    setComments((cs) => [...cs, { id, anchor_text: anchorText, body: "" }]);
    setFocusedCommentId(id);
  };
  const updateComment = (id: string, body: string) =>
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, body } : c)));
  const deleteComment = (id: string) => {
    setComments((cs) => cs.filter((c) => c.id !== id));
    // Strip the mark from the HTML
    const regex = new RegExp(`<span data-comment-id="${id}">(.*?)</span>`, "gs");
    setHtml((h) => h.replace(regex, "$1"));
  };

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 pb-32">
      <div className="mb-4">
        <Link href={`/runs/${runId}`} className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider">
          ← Run · {shortId}
        </Link>
      </div>

      <SectionHead
        kicker={<>Galley Proof · Stage 2 · <span className="text-accent">{shortId}</span></>}
        hed="Editor's review"
        dek="Final pass on the draft. Approve and push to WordPress as draft, request changes, or reject."
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
        {/* Galley column */}
        <section>
          <Tabs defaultValue="edit">
            <TabsList className="border-b border-rule">
              <TabsTrigger value="edit">Edit</TabsTrigger>
              <TabsTrigger value="diff">Diff vs render</TabsTrigger>
              <TabsTrigger value="audit">Audit findings</TabsTrigger>
            </TabsList>
            <TabsContent value="edit" className="pt-6">
              {render.isPending && (
                <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider animate-pulse">Loading draft…</p>
              )}
              {render.isError && (
                <p className="font-mono text-[12px] text-accent-deep">
                  Failed to load draft — {(render.error as Error).message}
                </p>
              )}
              {renderReady && (
                <TipTapEditor
                  value={html}
                  onChange={setHtml}
                  onAddComment={addComment}
                  onCommentClick={setFocusedCommentId}
                />
              )}
            </TabsContent>
            <TabsContent value="diff" className="pt-6">
              <HtmlDiffView original={originalHtml} updated={html} />
            </TabsContent>
            <TabsContent value="audit" className="pt-6">
              {audit.data && (
                <div className="space-y-3 text-[13px]">
                  <p className="font-mono text-[12px]">
                    OVERALL · <span className={audit.data.overall_pass ? "text-ok" : "text-accent-deep"}>{audit.data.overall_pass ? "PASS ✓" : "FAIL ✗"}</span>
                    {"  "}·  HIGH <span className="tabular-nums">{audit.data.severity_high}</span>
                    {"  "}·  MED <span className="tabular-nums">{audit.data.severity_medium}</span>
                    {"  "}·  LOW <span className="tabular-nums">{audit.data.severity_low}</span>
                  </p>
                  <ol className="space-y-3">
                    {[...audit.data.llm_findings.findings, ...audit.data.deterministic_findings.findings].map((f) => (
                      <li key={f.id} className="border-l-2 border-rule pl-4 py-1">
                        <div className="flex items-center gap-2 mb-1">
                          <PaperStamp tone={f.severity === "high" ? "danger" : f.severity === "medium" ? "warn" : "neutral"}>{f.severity}</PaperStamp>
                          <span className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">{f.category} · {f.location}</span>
                        </div>
                        <p className="text-ink">{f.issue}</p>
                        <p className="text-ink-soft text-[12px] mt-1">→ {f.suggested_fix}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </TabsContent>
          </Tabs>

          {/* Notes to AI */}
          <div className="mt-6">
            <p className="kicker mb-2">Notes to AI</p>
            <textarea
              value={form.notes ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={3}
              placeholder="Overall direction — e.g. 'lede should be punchier, lead with the surgery question.'"
              className="w-full resize-y border border-rule bg-paper rounded px-3 py-2 text-[14px] text-ink focus:outline-none focus:border-accent"
            />
          </div>
        </section>

        {/* Right rail — WP metadata ↔ Comments tab switcher */}
        <aside className="lg:sticky lg:top-32 self-start">
          <Tabs defaultValue="wp">
            <TabsList className="border-b border-rule">
              <TabsTrigger value="wp">WP metadata</TabsTrigger>
              <TabsTrigger value="comments">
                Comments {comments.length > 0 && <span className="ml-1 text-accent">({comments.length})</span>}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="wp" className="pt-4">
              <Card variant="editorial" className="px-5 py-5">
                <WordPressMetaForm form={form} onChange={setForm} />
              </Card>
            </TabsContent>
            <TabsContent value="comments" className="pt-4">
              <CommentsSidebar
                comments={comments}
                focusedId={focusedCommentId}
                onChange={updateComment}
                onDelete={deleteComment}
                onFocus={setFocusedCommentId}
              />
            </TabsContent>
          </Tabs>
        </aside>
      </div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 bg-paper/95 backdrop-blur border-t border-ink z-40">
        <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-3 flex items-center justify-end gap-3">
          {round > 0 && (
            <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint mr-auto">
              Round {round + 1} of {MAX_ROUNDS}
            </span>
          )}
          <Button variant="destructive" size="sm" disabled={!renderReady || submit.isPending} onClick={() => submit.mutate("reject")}>Reject ✕</Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!renderReady || submit.isPending || capReached || !hasFeedback}
            title={capReached ? "Cap reached — approve or reject." : !hasFeedback ? "Add a comment or note first." : ""}
            onClick={() => submit.mutate("request_changes")}
          >
            Request changes ↺
          </Button>
          <Button variant="primary" disabled={!renderReady || submit.isPending} onClick={() => submit.mutate("approve")}>
            {submit.isPending ? "Pushing…" : "Approve & push to WP ↪"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Ensure `api.getRun` exists**

Check `web/lib/api.ts` for a `getRun(runId)` method. If absent, add:

```typescript
getRun: (runId: string) =>
  fetch(`/api/runs/${runId}`).then((r) => {
    if (!r.ok) throw new Error(`getRun: ${r.status}`);
    return r.json() as Promise<RunSummary>;
  }),
```

(`RunSummary` already imported via `"@/lib/types"`.)

- [ ] **Step 3: Commit**

```bash
git add web/app/runs/[runId]/hitl2/page.tsx web/lib/api.ts
git commit -m "feat(web): hitl2 reviewer comments UI + revise loop integration"
```

---

## Task 11: End-to-end manual test in dev preview

**Files:** none — verification only.

- [ ] **Step 1: Restart API to pick up graph + schema changes**

```bash
# In the API terminal — Ctrl-C, then:
.venv/bin/python -m content_tool.api
```

(Or however the dev API is normally started in this repo.)

- [ ] **Step 2: Hit the HITL2 page in the dev preview**

Navigate to `http://localhost:3000/runs/<some-run-id-at-hitl2>/hitl2`. Use the same run as before (`7b16d462-...`) if it's still at hitl2; otherwise start a fresh run via "+ New run".

- [ ] **Step 3: Verify the new UI elements render**

- Right rail shows two tabs: **WP metadata** | **Comments**
- Comments tab is empty initially: "No comments yet."
- Editor toolbar unchanged from previous task.
- **Notes to AI** textarea visible below the editor tabs.
- Sticky action bar: "Reject", "Request changes" (disabled — no feedback yet), "Approve".

- [ ] **Step 4: Add a comment**

- Highlight a span of text in the editor.
- Verify the floating "Comment" pill appears near the selection.
- Click it. The Comments tab should activate (or at least show the new entry), with the anchor text quoted and an empty textarea.
- Type a comment. Verify the "Request changes" button enables.

- [ ] **Step 5: Submit `request_changes`**

- Click "Request changes". Page should navigate to `/runs/<id>`.
- Check `run.status` — it should NOT be `changes_requested`. It should be `revising` (transient) or already back at HITL2 with `hitl_2_iteration = 1`.
- Open the run detail page; once the production sub-graph finishes, status should be back at the HITL2 gate.
- Go back to `/runs/<id>/hitl2`. The Notes-to-AI textarea should be empty (we don't carry over old notes). The article HTML should be the new draft.
- The round badge should now read **"Round 2 of 3"**.

- [ ] **Step 6: Verify the cap**

- Iterate two more rounds (rounds 2 and 3).
- After the third `request_changes`, the "Request changes" button should be disabled with tooltip "Cap reached — approve or reject."

- [ ] **Step 7: Confirm DB row**

```bash
# In a psql shell against the content_tool schema
SELECT run_id, status, hitl_2_iteration, jsonb_array_length(hitl_2_comments)
FROM content_tool.runs WHERE run_id = '<your-run-id>';
```

Expected: `hitl_2_iteration` matches rounds taken; `hitl_2_comments` is the latest round's submission.

---

## Self-review

Cross-checked against the spec [docs/superpowers/specs/2026-05-24-hitl2-reviewer-comments-revise-loop-design.md](../specs/2026-05-24-hitl2-reviewer-comments-revise-loop-design.md):

- ✓ Anchored comments — Task 7 (mark), Task 8 (sidebar), Task 9 (selection pill + wiring), Task 10 (page integration).
- ✓ Overall note ("Notes to AI") — Task 10.
- ✓ Targeted edits via writer `refine_notes` — Task 5 step 1.
- ✓ Loop back to HITL2 — Task 5 step 2 (`route_after_publish_or_revise`).
- ✓ 3-round cap — UI (Task 10), backend 409 (Task 4), graph terminal (Task 5).
- ✓ Full production sub-graph re-entry — Task 5 step 2 (reset `iteration`, clear `writer_output`/`render`/`audit_findings`).
- ✓ HTML sanitization on persistence — Task 3 utility; integration point is in `publish_to_wordpress` and `n_writer`'s draft input — note: **the utility is defined but not yet invoked in the production graph**. This is intentional: the comment marks live only in the volatile `state["render"]["html_body"]`-equivalent passed through the writer prompt, not in any persisted `Draft` row, because `n_writer` regenerates `markup_raw` from scratch each round. The strip util is available for the publish path if we ever start persisting `edited_html_body` as a draft — current code does not, so no integration is required.
- ✓ DB columns + migration — Task 1.
- ✓ Schema updates — Task 2.
- ✓ Edge cases:
  - Orphaned comment — Task 10 step 1 (`liveComments` filter).
  - Cap race — Task 4 (409) + Task 10 (`capReached`).
  - Empty submission — Task 10 (`hasFeedback` gate).

**Placeholder scan:** no TBDs, no "TODO later", all code blocks complete.

**Type consistency:** `Hitl2Comment` shape (`id`, `anchor_text`, `body`) consistent across Python (Task 2), utility consumers (Task 5), TS (Task 6), sidebar (Task 8), TipTap callback (Task 9), page (Task 10).
