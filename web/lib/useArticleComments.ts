"use client";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Hitl2Comment } from "@/lib/types";
import { stripCommentSpan } from "@/lib/comment-anchor";

interface ArticleCommentsOpts {
  onAddComment?: () => void;
  onFocusComment?: () => void;
}

/**
 * Anchored-comment state shared by the HITL_2 review page and the standalone
 * edit page. Owns the comment list + which one is focused, and keeps the editor
 * body in sync when a comment is removed (strips its anchor span).
 *
 * `onAddComment` / `onFocusComment` let the host page react (e.g. switch the
 * right rail to the Comments tab) without baking that layout choice into the hook.
 * They are read through a ref so the returned handlers stay referentially stable
 * even when callers pass fresh inline lambdas each render.
 */
export function useArticleComments(
  setHtml: (updater: (html: string) => string) => void,
  opts: ArticleCommentsOpts = {},
) {
  const [comments, setComments] = useState<Hitl2Comment[]>([]);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);

  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const addComment = useCallback((id: string, anchorText: string) => {
    setComments((cs) => [...cs, { id, anchor_text: anchorText, body: "" }]);
    setFocusedCommentId(id);
    optsRef.current.onAddComment?.();
  }, []);

  const updateComment = useCallback((id: string, body: string) => {
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, body } : c)));
  }, []);

  const deleteComment = useCallback(
    (id: string) => {
      setComments((cs) => cs.filter((c) => c.id !== id));
      setHtml((h) => stripCommentSpan(h, id));
      setFocusedCommentId((f) => (f === id ? null : f));
    },
    [setHtml],
  );

  const focusComment = useCallback((id: string) => {
    setFocusedCommentId(id);
    optsRef.current.onFocusComment?.();
  }, []);

  return {
    comments,
    setComments,
    focusedCommentId,
    setFocusedCommentId,
    addComment,
    updateComment,
    deleteComment,
    focusComment,
  };
}
