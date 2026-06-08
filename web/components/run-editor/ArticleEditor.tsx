"use client";
import { useState } from "react";
import { Pencil, GitCompareArrows } from "lucide-react";

import { TipTapEditor } from "@/components/TipTapEditor";
import { InlineTrackedChanges } from "@/components/InlineTrackedChanges";
import { cn } from "@/lib/utils";
import type { CommitResult } from "@/lib/tracked-changes";

type ArticleMode = "edit" | "review";

interface ArticleEditorProps {
  /** The live working body (editor HTML). */
  html: string;
  /** The committed tracked-changes baseline. */
  committedHtml: string;
  /** Number of pending human tracked changes (drives the Review badge). */
  pendingCount: number;
  /** Working-body edits from the visual editor. */
  onHtmlChange: (html: string) => void;
  /** Accept/reject result from the inline tracked-changes review. */
  onTrackedChange: (next: CommitResult) => void;
  /** Open a human review thread anchored on a tracked change's text. */
  onComment: (anchorText: string) => void;
  /** AI-edit instruction anchor (passed through to the visual editor). */
  onAddComment: (id: string, anchorText: string) => void;
  onCommentClick: (id: string) => void;
  /** Human review-thread anchor (passed through to the visual editor). */
  onAddReviewNote: (id: string, anchorText: string) => void;
  onReviewClick: (id: string) => void;
}

/**
 * The article surface shared by /hitl2 and /edit: a visual TipTap editor with an
 * inline tracked-changes review mode toggled in place. **Edit** is the live
 * editor; **Review changes** renders the committed-baseline → working diff as the
 * rendered article (green insertions, red strikethrough deletions) with an
 * Accept / Reject / Comment popover per change. Both modes read and write the
 * same `html` / `committedHtml` state, so toggling never loses work.
 */
export function ArticleEditor({
  html,
  committedHtml,
  pendingCount,
  onHtmlChange,
  onTrackedChange,
  onComment,
  onAddComment,
  onCommentClick,
  onAddReviewNote,
  onReviewClick,
}: ArticleEditorProps) {
  const [mode, setMode] = useState<ArticleMode>("edit");

  return (
    <div>
      <div className="mb-3 inline-flex items-center gap-0.5 rounded border border-rule bg-paper p-0.5">
        <ModeButton active={mode === "edit"} onClick={() => setMode("edit")}>
          <Pencil className="h-3.5 w-3.5" /> Edit
        </ModeButton>
        <ModeButton active={mode === "review"} onClick={() => setMode("review")}>
          <GitCompareArrows className="h-3.5 w-3.5" /> Review changes
          {pendingCount > 0 && (
            <span className={cn("ml-1", mode === "review" ? "text-paper" : "text-accent")}>
              ({pendingCount})
            </span>
          )}
        </ModeButton>
      </div>

      {mode === "edit" ? (
        <TipTapEditor
          value={html}
          onChange={onHtmlChange}
          onAddComment={onAddComment}
          onCommentClick={onCommentClick}
          onAddReviewNote={onAddReviewNote}
          onReviewClick={onReviewClick}
        />
      ) : (
        <InlineTrackedChanges
          committed={committedHtml}
          working={html}
          onChange={onTrackedChange}
          onComment={onComment}
        />
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors",
        active ? "bg-ink text-paper" : "text-ink-soft hover:text-ink hover:bg-paper-deep",
      )}
    >
      {children}
    </button>
  );
}
