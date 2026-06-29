"use client";
import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";

import { AnchorQuote } from "@/components/annotations/AnchorQuote";
import { AnnotationCard } from "@/components/annotations/AnnotationCard";
import type { Hitl2Comment } from "@/lib/types";

interface Props {
  comments: Hitl2Comment[];
  focusedId: string | null;
  onChange: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onFocus: (id: string) => void;
}

export function CommentsSidebar({
  comments,
  focusedId,
  onChange,
  onDelete,
  onFocus,
}: Props) {
  const refs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  useEffect(() => {
    const el = focusedId ? refs.current[focusedId] : null;
    if (!el) return;
    el.focus();
    // `scrollIntoView` is absent in jsdom and older webviews — guard it (matches
    // ReviewThreadList) so focusing a comment never throws.
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
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
        <AnnotationCard key={c.id} focused={focusedId === c.id} onClick={() => onFocus(c.id)}>
          <AnchorQuote text={c.anchor_text} className="mb-2" />
          <textarea
            ref={(el) => {
              refs.current[c.id] = el;
            }}
            value={c.body}
            onChange={(e) => onChange(c.id, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            rows={2}
            placeholder="What needs to change?"
            className="w-full resize-y text-[13px] text-ink bg-transparent focus:outline-none border-b border-rule focus:border-accent pb-1"
          />
          <div className="flex items-center justify-end mt-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm("Delete this comment? This cannot be undone.")) onDelete(c.id);
              }}
              className="text-ink-faint hover:text-accent-deep inline-flex items-center gap-1 text-[11px]"
              aria-label="Delete comment"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        </AnnotationCard>
      ))}
    </ul>
  );
}
