"use client";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { Hitl2Comment } from "@/lib/types";

interface ApplyEditsCallbacks {
  /** Called with the revised HTML after a single comment's edit is applied. */
  onCommentApplied: (commentId: string, html: string) => void;
  /** Called with the revised HTML after the overall "Notes to AI" edit. */
  onNotesApplied: (html: string) => void;
}

/**
 * Inline AI-edit mutations shared by the review and edit pages. A per-comment
 * apply revises just that highlighted span; the overall apply revises the whole
 * article from the notes. Both return revised HTML the host page swaps into the
 * editor — no pipeline re-run.
 */
export function useApplyEdits(runId: string, cb: ApplyEditsCallbacks) {
  const applyComment = useMutation({
    mutationFn: (v: { comment: Hitl2Comment; html: string }) =>
      api.applyEdits(runId, { html_body: v.html, comments: [v.comment], notes: null }),
    onSuccess: (res, v) => {
      cb.onCommentApplied(v.comment.id, res.html_body);
      toast.success("Applied edit to highlight");
    },
    onError: (e: Error) => toast.error(`Couldn't apply edit — ${e.message}`),
  });

  const applyNotes = useMutation({
    mutationFn: (v: { notes: string; html: string }) =>
      api.applyEdits(runId, { html_body: v.html, comments: null, notes: v.notes }),
    onSuccess: (res) => {
      cb.onNotesApplied(res.html_body);
      toast.success("Applied notes to article");
    },
    onError: (e: Error) => toast.error(`Couldn't apply notes — ${e.message}`),
  });

  const applyingCommentId = applyComment.isPending
    ? applyComment.variables?.comment.id ?? null
    : null;

  return { applyComment, applyNotes, applyingCommentId };
}
