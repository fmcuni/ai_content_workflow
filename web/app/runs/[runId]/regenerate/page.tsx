"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { TipTapEditor } from "@/components/TipTapEditor";
import { CommentsSidebar } from "@/components/CommentsSidebar";
import { RunEditorShell } from "@/components/run-editor/RunEditorShell";
import { NotesToAi } from "@/components/run-editor/NotesToAi";
import { api } from "@/lib/api";
import type { Hitl2Comment } from "@/lib/types";

export default function RegeneratePage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();

  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId) });
  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });

  const [html, setHtml] = useState("");
  const [comments, setComments] = useState<Hitl2Comment[]>([]);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (render.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHtml(render.data.html_body);
    }
  }, [render.data]);

  const addComment = (id: string, anchorText: string) => {
    setComments((cs) => [...cs, { id, anchor_text: anchorText, body: "" }]);
    setFocusedCommentId(id);
  };
  const updateComment = (id: string, body: string) =>
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, body } : c)));
  const deleteComment = (id: string) => {
    setComments((cs) => cs.filter((c) => c.id !== id));
    const regex = new RegExp(`<span data-comment-id="${id}">(.*?)</span>`, "gs");
    setHtml((h) => h.replace(regex, "$1"));
    if (focusedCommentId === id) setFocusedCommentId(null);
  };

  const renderReady = Boolean(render.data);
  const hasFeedback =
    comments.some((c) => c.body.trim().length > 0) || notes.trim().length > 0;

  const regen = useMutation({
    mutationFn: () => {
      // Drop orphaned comments whose anchor span was removed from the HTML.
      const liveComments = comments.filter((c) => html.includes(`data-comment-id="${c.id}"`));
      return api.regenerate(runId, { notes: notes || null, comments: liveComments });
    },
    onSuccess: () => {
      toast.success("Regenerated — review and re-push from the edit page");
      router.push(`/runs/${runId}/edit`);
    },
    onError: (e: Error) => toast.error(`Regeneration failed — ${e.message}`),
  });

  return (
    <RunEditorShell
      runId={runId}
      run={run.data}
      kicker={<>Regenerate · <span className="text-accent">{shortId}</span></>}
      hed="Editor's review"
      dek="Mark up the published draft with anchored comments and overall notes, then let the AI regenerate. The new draft lands on the edit page for you to verify and re-push."
      actionBar={
        <>
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint mr-auto">
            Round {(run.data?.hitl_2_iteration ?? 0) + 1}
          </span>
          <Button
            variant="primary"
            disabled={!renderReady || regen.isPending || !hasFeedback}
            title={!hasFeedback ? "Add a comment or note first." : ""}
            onClick={() => regen.mutate()}
          >
            {regen.isPending ? "Regenerating…" : "Regenerate with AI ↺"}
          </Button>
        </>
      }
    >
      <section>
          <p className="kicker mb-3">Current article — select text to comment</p>
          {render.isPending && (
            <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider animate-pulse">
              Loading draft…
            </p>
          )}
          {render.isError && (
            <p className="font-mono text-[12px] text-ink-soft">
              No rendered article exists for this run yet — nothing to regenerate.
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

          <NotesToAi value={notes} onChange={setNotes} />
        </section>

        <aside className="lg:sticky lg:top-[6.25rem] self-start lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto">
          <p className="kicker mb-3">
            Comments{comments.length > 0 && <span className="ml-1 text-accent">({comments.length})</span>}
          </p>
          <CommentsSidebar
            comments={comments}
            focusedId={focusedCommentId}
            onChange={updateComment}
            onDelete={deleteComment}
            onFocus={setFocusedCommentId}
          />
        </aside>
    </RunEditorShell>
  );
}
