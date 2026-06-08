"use client";
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { setReviewSpanResolved, stripReviewSpan } from "@/lib/review-anchor";
import type { ReviewThread } from "@/lib/types";

interface Identity {
  /** Author email — sent to the Python sidecar; Workers overrides from session. */
  readonly email: string;
  /** Display name for the message author (used for the avatar + byline). */
  readonly name: string;
}

/**
 * Server-backed human review threads (comment / reply / resolve), shared by
 * /hitl2 and /edit. A SEPARATE pipeline from the in-memory AI-edit comments
 * (`useArticleComments`): these persist in the `review_threads` table and are
 * never dispatched to the AI.
 *
 * `setHtml` lets thread mutations keep the editor body's highlight spans in
 * sync — stripping a deleted thread's span and dimming a resolved one — so the
 * annotation state survives into the saved snapshot.
 */
export function useReviewThreads(
  runId: string,
  identity: Identity,
  setHtml: (updater: (html: string) => string) => void,
) {
  const qc = useQueryClient();
  const queryKey = ["review-threads", runId];

  const query = useQuery({
    queryKey,
    queryFn: () => api.listReviewThreads(runId),
  });
  const threads: ReviewThread[] = useMemo(() => query.data ?? [], [query.data]);

  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  // A highlight awaiting its first comment. The anchor span already exists in
  // the body; the thread is only persisted once the operator submits the first
  // message (so abandoning the highlight leaves no empty server row).
  const [pending, setPending] = useState<{ anchorId: string; anchorText: string } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey });
  const author = { editor_email: identity.email, editor_name: identity.name };

  const create = useMutation({
    mutationFn: (v: { anchor_id: string; anchor_text: string; body: string }) =>
      api.createReviewThread(runId, { ...v, ...author }),
    onSuccess: (thread) => {
      invalidate();
      setFocusedThreadId(thread.thread_id);
    },
  });

  const reply = useMutation({
    mutationFn: (v: { threadId: string; body: string }) =>
      api.replyReviewThread(runId, v.threadId, { body: v.body, ...author }),
    onSuccess: invalidate,
  });

  const resolve = useMutation({
    mutationFn: (v: { thread: ReviewThread; resolved: boolean }) =>
      api.resolveReviewThread(runId, v.thread.thread_id, { resolved: v.resolved, ...author }),
    onSuccess: (_data, v) => {
      invalidate();
      setHtml((h) => setReviewSpanResolved(h, v.thread.anchor_id, v.resolved));
    },
  });

  const remove = useMutation({
    mutationFn: (thread: ReviewThread) => api.deleteReviewThread(runId, thread.thread_id),
    onSuccess: (_data, thread) => {
      invalidate();
      setHtml((h) => stripReviewSpan(h, thread.anchor_id));
      setFocusedThreadId((f) => (f === thread.thread_id ? null : f));
    },
  });

  // Map a highlight click (`data-review-id`) to its thread for focus.
  const focusByAnchor = useCallback(
    (anchorId: string) => {
      const match = threads.find((t) => t.anchor_id === anchorId);
      if (match) setFocusedThreadId(match.thread_id);
    },
    [threads],
  );

  // Begin a new thread: a highlight was just made, awaiting its first comment.
  const beginThread = useCallback((anchorId: string, anchorText: string) => {
    setPending({ anchorId, anchorText });
  }, []);

  const cancelPending = useCallback(() => {
    if (pending) setHtml((h) => stripReviewSpan(h, pending.anchorId));
    setPending(null);
  }, [pending, setHtml]);

  const submitPending = useCallback(
    (body: string) => {
      if (!pending) return;
      create.mutate({ anchor_id: pending.anchorId, anchor_text: pending.anchorText, body });
      setPending(null);
    },
    [pending, create],
  );

  return {
    threads,
    isLoading: query.isLoading,
    isError: query.isError,
    focusedThreadId,
    setFocusedThreadId,
    focusByAnchor,
    pending,
    beginThread,
    cancelPending,
    submitPending,
    create,
    reply,
    resolve,
    remove,
  };
}

export type ReviewThreadsApi = ReturnType<typeof useReviewThreads>;
