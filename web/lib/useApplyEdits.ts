"use client";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { Hitl2Comment } from "@/lib/types";

/** What the operator asked the AI to act on for this request. */
interface AppliedContext {
  /** Ids of the comments sent (empty when the request was a whole-article note). */
  commentIds: string[];
  /** True when a whole-article "Whole article change" note was sent. */
  hadNotes: boolean;
}

interface ApplyEditsCallbacks {
  /** Called with the revised HTML after the AI edit returns. */
  onApplied: (html: string, ctx: AppliedContext) => void;
}

interface RequestEditVars {
  html: string;
  comments: Hitl2Comment[];
  notes: string | null;
}

/**
 * The single inline AI-edit mutation shared by the review and edit pages. The
 * "Request AI to edit" button drives it: when the operator has highlight
 * comments those take priority and are sent as `comments`; otherwise the
 * whole-article note is sent as `notes`. The agent returns revised HTML the host
 * page swaps into the editor — no pipeline re-run.
 */
export function useApplyEdits(runId: string, cb: ApplyEditsCallbacks) {
  const requestEdit = useMutation({
    mutationFn: (v: RequestEditVars) =>
      api.applyEdits(runId, {
        html_body: v.html,
        comments: v.comments.length > 0 ? v.comments : null,
        notes: v.notes,
      }),
    onSuccess: (res, v) => {
      cb.onApplied(res.html_body, {
        commentIds: v.comments.map((c) => c.id),
        hadNotes: (v.notes ?? "").trim().length > 0,
      });
      toast.success("Applied AI edit");
    },
    onError: (e: Error) => toast.error(`Couldn't apply edit — ${e.message}`),
  });

  return { requestEdit, requesting: requestEdit.isPending };
}
