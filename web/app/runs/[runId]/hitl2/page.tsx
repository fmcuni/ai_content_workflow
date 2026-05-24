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
import type { Hitl2Comment, Hitl2Request } from "@/lib/types";

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
  const [rightTab, setRightTab] = useState<"wp" | "comments">("wp");

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
  const hasFeedback =
    comments.some((c) => c.body.trim().length > 0) || (form.notes ?? "").trim().length > 0;

  const submit = useMutation({
    mutationFn: (decision: Hitl2Request["decision"]) => {
      // Drop orphaned comments — those whose mark no longer exists in the HTML
      // (reviewer deleted the span). Other decisions don't send comments.
      const liveComments =
        decision === "request_changes"
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
    setRightTab("comments");
  };
  const updateComment = (id: string, body: string) =>
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, body } : c)));
  const deleteComment = (id: string) => {
    setComments((cs) => cs.filter((c) => c.id !== id));
    // Strip the corresponding mark from the HTML payload so it doesn't ride along.
    const regex = new RegExp(`<span data-comment-id="${id}">(.*?)</span>`, "gs");
    setHtml((h) => h.replace(regex, "$1"));
    if (focusedCommentId === id) setFocusedCommentId(null);
  };
  const focusComment = (id: string) => {
    setFocusedCommentId(id);
    setRightTab("comments");
  };

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 pb-32">
      <div className="mb-4">
        <Link
          href={`/runs/${runId}`}
          className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider"
        >
          ← Run · {shortId}
        </Link>
      </div>

      <SectionHead
        kicker={
          <>
            Galley Proof · Stage 2 · <span className="text-accent">{shortId}</span>
          </>
        }
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
                <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider animate-pulse">
                  Loading draft…
                </p>
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
                  onCommentClick={focusComment}
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
                    OVERALL ·{" "}
                    <span className={audit.data.overall_pass ? "text-ok" : "text-accent-deep"}>
                      {audit.data.overall_pass ? "PASS ✓" : "FAIL ✗"}
                    </span>
                    {"  "}· HIGH{" "}
                    <span className="tabular-nums">{audit.data.severity_high}</span>
                    {"  "}· MED{" "}
                    <span className="tabular-nums">{audit.data.severity_medium}</span>
                    {"  "}· LOW{" "}
                    <span className="tabular-nums">{audit.data.severity_low}</span>
                  </p>
                  <ol className="space-y-3">
                    {[
                      ...audit.data.llm_findings.findings,
                      ...audit.data.deterministic_findings.findings,
                    ].map((f) => (
                      <li key={f.id} className="border-l-2 border-rule pl-4 py-1">
                        <div className="flex items-center gap-2 mb-1">
                          <PaperStamp
                            tone={
                              f.severity === "high"
                                ? "danger"
                                : f.severity === "medium"
                                ? "warn"
                                : "neutral"
                            }
                          >
                            {f.severity}
                          </PaperStamp>
                          <span className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">
                            {f.category} · {f.location}
                          </span>
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
          <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as "wp" | "comments")}>
            <TabsList className="border-b border-rule">
              <TabsTrigger value="wp">WP metadata</TabsTrigger>
              <TabsTrigger value="comments">
                Comments
                {comments.length > 0 && (
                  <span className="ml-1 text-accent">({comments.length})</span>
                )}
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
                onFocus={focusComment}
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
          <Button
            variant="destructive"
            size="sm"
            disabled={!renderReady || submit.isPending}
            onClick={() => submit.mutate("reject")}
          >
            Reject ✕
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!renderReady || submit.isPending || capReached || !hasFeedback}
            title={
              capReached
                ? "Cap reached — approve or reject."
                : !hasFeedback
                ? "Add a comment or note first."
                : ""
            }
            onClick={() => submit.mutate("request_changes")}
          >
            Request changes ↺
          </Button>
          <Button
            variant="primary"
            disabled={!renderReady || submit.isPending}
            onClick={() => submit.mutate("approve")}
          >
            {submit.isPending ? "Pushing…" : "Approve & push to WP ↪"}
          </Button>
        </div>
      </div>
    </div>
  );
}
