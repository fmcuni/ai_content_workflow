"use client";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { RoleButton } from "@/components/RoleGate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExternalLink } from "@/components/ExternalLink";
import { PaperStamp } from "@/components/PaperStamp";
import { HtmlDiffView } from "@/components/HtmlDiffView";
import { computeTrackedChanges } from "@/lib/tracked-changes";
import { RunEditorShell } from "@/components/run-editor/RunEditorShell";
import { ArticleEditor } from "@/components/run-editor/ArticleEditor";
import { EditorRail, type EditorRailTab } from "@/components/run-editor/EditorRail";
import { ReviewPanel } from "@/components/run-editor/ReviewPanel";
import { Hitl2VersionHistory } from "@/components/Hitl2VersionHistory";
import { RawHtmlView } from "@/components/RawHtmlView";
import { WpPayloadView } from "@/components/WpPayloadView";
import { useArticleComments } from "@/lib/useArticleComments";
import { useReviewThreads } from "@/lib/useReviewThreads";
import { useApplyEdits } from "@/lib/useApplyEdits";
import { stripCommentSpan } from "@/lib/comment-anchor";
import { buildDryRequest, buildSnapshotIn, snapshotKey } from "@/lib/run-editor/form";
import { useWpPayloadPreview } from "@/lib/run-editor/useWpPayloadPreview";
import { useSnapshotAutosave } from "@/lib/run-editor/useSnapshotAutosave";
import { useCollabDoc } from "@/lib/run-editor/useCollabDoc";
import { useSeedCollabDoc } from "@/lib/run-editor/useSeedCollabDoc";
import { isCollabEnabled } from "@/lib/run-editor/collab-flag";
import { NEUTRAL_COLLAB_COLOR } from "@/lib/run-editor/collab-color";
import { flattenCollabDoc } from "@/lib/run-editor/collab-html";
import { type TipTapCollab } from "@/components/TipTapEditor";
import { RunEditorHeaderActions } from "@/components/run-editor/RunEditorHeaderActions";
import { useRole } from "@/lib/use-role";
import { useSession } from "@/lib/auth-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { ExistingPost, Hitl2Request, Hitl2Snapshot, Hitl2SnapshotIn } from "@/lib/types";

export default function Hitl2Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();

  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });
  const audit = useQuery({ queryKey: ["audit", runId], queryFn: () => api.getLatestAudit(runId) });
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId) });

  const qc = useQueryClient();

  // Editing the draft (manual save, apply-edits) is a viewer-level capability;
  // the approve/reject/request-changes decisions stay editor-level (see the
  // RoleButton `need` props on the action bar below).
  const { can } = useRole();
  const canEdit = can("edit_article");

  // Authenticated approver/author identity (email) sent with HITL_2 decisions and
  // snapshots for the audit trail. Mirrored into a ref so the autosave/beacon
  // handlers (which run outside render) read the latest without re-subscribing.
  const { data: session } = useSession();
  const editorEmail = session?.user?.email ?? "";
  const editorName = session?.user?.name ?? "";
  const editorEmailRef = useRef(editorEmail);
  useEffect(() => {
    editorEmailRef.current = editorEmail;
  }, [editorEmail]);

  // Realtime collaboration — flag-gated OFF by default (Phase 5 flips it). With
  // the flag off, useCollabDoc returns a frozen disabled handle (no socket, ydoc
  // null, status "disabled") → collabActive false → collab null → every path
  // below is byte-identical to the string-snapshot editor.
  const collabEnabled = isCollabEnabled();
  const collabUser = useMemo(
    () => ({ name: editorName || editorEmail || "Editor", email: editorEmail }),
    [editorName, editorEmail],
  );
  const { ydoc, provider, status: collabStatus, color: collabColor } = useCollabDoc(runId, {
    enabled: collabEnabled,
    user: collabUser,
  });
  const collabActive = collabEnabled && ydoc !== null && provider !== null;
  const collab: TipTapCollab | null =
    collabActive && ydoc && provider
      ? { ydoc, provider, user: { name: collabUser.name, color: collabColor ?? NEUTRAL_COLLAB_COLOR } }
      : null;

  useSeedCollabDoc({
    ydoc,
    status: collabStatus,
    draftHtml: render.data?.html_body ?? "",
    enabled: collabActive && render.data !== undefined,
  });

  // Stable flatten callback (keyed on the live doc) so the autosave hook's
  // interval/beacon effects don't reset every render once collab is on. Undefined
  // when collab is off → the autosave keeps its byte-identical string path.
  const flattenBody = useMemo(
    () => (collabActive && ydoc ? () => flattenCollabDoc(ydoc) : undefined),
    [collabActive, ydoc],
  );

  const existingPost = useQuery({
    queryKey: ["existing-post", runId],
    queryFn: () => api.getExistingPost(runId),
    retry: false, // 404 is expected on the new-post path
  });

  const prefilledRef = useRef<ExistingPost | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Captured when the confirm dialog opens so the description can show which
  // fields would be overwritten without reading the prefill ref during render.
  const [dirtyFields, setDirtyFields] = useState<("Author" | "Category" | "Slug")[]>([]);
  // Set once a HITL_2 decision is submitted, so autosave-on-exit doesn't write a
  // redundant snapshot as the page navigates away after approve/request/reject.
  const submittedRef = useRef(false);
  // Hydration runs once, after the snapshot list resolves. When a saved snapshot
  // exists it seeds the editor and these refs stop the render/WP prefills from
  // clobbering the restored work.
  const hydratedFromSnapshotRef = useRef(false);

  const refresh = useMutation({
    mutationFn: () => api.refreshExistingPost(runId),
    onSuccess: (fresh) => {
      prefilledRef.current = fresh;
      setForm((f) => ({
        ...f,
        wp_author_id: fresh.wp_author_id,
        wp_category_ids: fresh.wp_category_id != null ? [fresh.wp_category_id] : null,
        wp_slug: fresh.wp_slug,
      }));
      qc.setQueryData(["existing-post", runId], fresh);
    },
    onError: () => toast.error("Couldn't re-read from WordPress"),
  });

  function getDirtyFields(): ("Author" | "Category" | "Slug")[] {
    const baseline = prefilledRef.current;
    if (!baseline) return [];
    const dirty: ("Author" | "Category" | "Slug")[] = [];
    if ((form.wp_author_id ?? null) !== (baseline.wp_author_id ?? null)) dirty.push("Author");
    const formCat = form.wp_category_ids?.[0] ?? null;
    if (formCat !== (baseline.wp_category_id ?? null)) dirty.push("Category");
    if ((form.wp_slug ?? null) !== (baseline.wp_slug ?? null)) dirty.push("Slug");
    return dirty;
  }

  function handleRereadClick() {
    const dirty = getDirtyFields();
    if (dirty.length === 0) {
      refresh.mutate();
    } else {
      setDirtyFields(dirty);
      setConfirmOpen(true);
    }
  }

  const [html, setHtml] = useState<string>("");
  const [form, setForm] = useState<Hitl2Request>({ decision: "approve", wp_publish_status: "draft" });
  const [originalHtml, setOriginalHtml] = useState("");
  // Tracked-changes baseline: the last committed body. Human edits to `html`
  // away from this show as pending tracked changes. Defaults to the render so a
  // freshly-loaded draft has zero pending; AI edits advance it (no false hunks).
  const [committedHtml, setCommittedHtml] = useState("");
  const [rightTab, setRightTab] = useState<EditorRailTab>("wp");
  const {
    comments,
    setComments,
    focusedCommentId,
    setFocusedCommentId,
    addComment,
    updateComment,
    deleteComment,
    focusComment,
  } = useArticleComments(setHtml, {
    onAddComment: () => setRightTab("comments"),
    onFocusComment: () => setRightTab("comments"),
  });
  // Human review threads — SEPARATE pipeline from the AI "comments" above.
  const reviewThreads = useReviewThreads(runId, { email: editorEmail, name: editorName }, setHtml);
  const onAddReviewNote = (id: string, anchorText: string) => {
    reviewThreads.beginThread(id, anchorText);
    setRightTab("review");
  };
  const onReviewClick = (anchorId: string) => {
    reviewThreads.focusByAnchor(anchorId);
    setRightTab("review");
  };
  const { requestEdit, requesting } = useApplyEdits(runId, {
    onApplied: (newHtml, ctx) => {
      if (ctx.commentIds.length > 0) {
        // Strip the addressed comments' anchor spans and drop them from the list.
        const cleaned = ctx.commentIds.reduce(stripCommentSpan, newHtml);
        const sent = new Set(ctx.commentIds);
        setHtml(cleaned);
        // AI edits advance the tracked-changes baseline so they never surface as
        // pending HUMAN changes (tracked changes are human-only).
        setCommittedHtml(cleaned);
        setComments((cs) => cs.filter((c) => !sent.has(c.id)));
        setFocusedCommentId((f) => (f && sent.has(f) ? null : f));
      } else {
        setHtml(newHtml);
        setCommittedHtml(newHtml);
        setForm((f) => ({ ...f, notes: "" }));
      }
    },
  });

  // Highlight comments take priority over the whole-article note. The single
  // "Request AI to edit" button sends whichever is present.
  const liveComments = comments.filter((c) => c.body.trim().length > 0);
  const requestEnabled = liveComments.length > 0 || (form.notes ?? "").trim().length > 0;
  const requestAiEdit = () => {
    if (liveComments.length > 0) {
      requestEdit.mutate({ html, comments: liveComments, notes: null });
    } else if ((form.notes ?? "").trim().length > 0) {
      requestEdit.mutate({ html, comments: [], notes: form.notes ?? "" });
    }
  };
  const [galleyTab, setGalleyTab] = useState<
    "edit" | "diff" | "audit" | "raw" | "payload"
  >("edit");
  // Pending human tracked changes (committed baseline vs working body).
  const pendingChanges = useMemo(
    () => computeTrackedChanges(committedHtml, html).hunks.length,
    [committedHtml, html],
  );
  // Start a review thread from a tracked change (its text is the anchor).
  const commentOnChange = (anchorText: string) => {
    reviewThreads.beginThread(
      `r-${Math.random().toString(36).slice(2, 10)}`,
      anchorText,
    );
    setRightTab("review");
  };
  const wpPayload = useWpPayloadPreview(runId, () => buildDryRequest(html, form));

  useEffect(() => {
    if (render.data) {
      // Diff baseline is always the pristine render, even when restoring a snapshot.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOriginalHtml(render.data.html_body);
      if (hydratedFromSnapshotRef.current) return; // snapshot owns the editor body
      setHtml(render.data.html_body);
      // No pending tracked changes on a fresh draft: baseline = working body.
      setCommittedHtml(render.data.html_body);
      setForm((f) => ({
        ...f,
        edited_seo_title: render.data!.seo_title,
        edited_meta_description: render.data!.meta_description,
        wp_excerpt: render.data!.excerpt_suggestion,
      }));
    }
  }, [render.data]);

  useEffect(() => {
    if (!existingPost.data) return;
    if (prefilledRef.current !== null) return; // already prefilled
    prefilledRef.current = existingPost.data; // WP baseline for "Re-read from WP"
    const ep = existingPost.data;
    // Backfill the WP baseline only where the field is still empty. A snapshot
    // hydration that didn't carry author/category/slug must not leave them blank
    // (the "auto-filled then cleared" bug); a value the snapshot DID carry is
    // preserved. Works whichever query wins the race vs snapshot hydration.
    setForm((f) => ({
      ...f,
      wp_author_id: f.wp_author_id ?? ep.wp_author_id,
      wp_category_ids:
        f.wp_category_ids ?? (ep.wp_category_id != null ? [ep.wp_category_id] : null),
      wp_slug: f.wp_slug ?? ep.wp_slug,
    }));
  }, [existingPost.data]);

  const renderReady = Boolean(render.data);
  // Reachable by direct URL / bookmark even after the draft gate is resolved
  // (e.g. an already-published run). Only allow the live Reject / Request-changes
  // / Approve actions while the run is genuinely paused at HITL_2.
  const atGate = run.data?.status === "hitl_2";
  const gateResolved = run.data != null && !atGate;

  const submit = useMutation({
    // Inline AI edits happen at the gate via "Request AI to edit"; the remaining
    // decisions (approve / reject) carry the current edited HTML, no comments.
    mutationFn: (decision: Hitl2Request["decision"]) =>
      api.resumeHitl2(runId, {
        ...form,
        decision,
        edited_html_body: collab ? flattenCollabDoc(collab.ydoc) : html,
        comments: [],
        editor_email: editorEmail,
      }),
    onSuccess: () => {
      submittedRef.current = true;
      router.push(`/runs/${runId}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // --- Autosave + version history -----------------------------------------
  const [historyOpen, setHistoryOpen] = useState(false);

  const snapshotIn = useMemo<Hitl2SnapshotIn>(
    () => buildSnapshotIn(html, form, comments, "manual", committedHtml),
    [html, form, comments, committedHtml],
  );

  // Baseline is derived from the same source data the prefill effects consume,
  // so a freshly-loaded page never reads as dirty before any real edit.
  const baselineKey = useMemo(() => {
    if (!render.data || !existingPost.isFetched) return null;
    return snapshotKey({
      trigger: "manual",
      html_body: render.data.html_body,
      committed_html_body: render.data.html_body,
      seo_title: render.data.seo_title,
      meta_description: render.data.meta_description,
      notes: null,
      comments: [],
      wp_publish_status: "draft",
      wp_author_id: existingPost.data?.wp_author_id ?? null,
      wp_category_ids:
        existingPost.data?.wp_category_id != null ? [existingPost.data.wp_category_id] : null,
      wp_tag_ids: null,
      wp_featured_media_id: null,
      wp_slug: existingPost.data?.wp_slug ?? null,
      wp_excerpt: render.data.excerpt_suggestion ?? null,
      wp_publish_at: null,
    });
  }, [render.data, existingPost.data, existingPost.isFetched]);

  const applySnapshot = useCallback((s: Hitl2Snapshot) => {
    setHtml(s.html_body);
    // Restore the tracked-changes baseline; older snapshots without one have no
    // pending changes (committed == body).
    setCommittedHtml(s.committed_html_body ?? s.html_body);
    setComments(s.comments ?? []);
    setForm((f) => ({
      ...f,
      notes: s.notes ?? undefined,
      edited_seo_title: s.seo_title ?? null,
      edited_meta_description: s.meta_description ?? null,
      wp_publish_status: (s.wp_publish_status as Hitl2Request["wp_publish_status"]) ?? "draft",
      // Author/category/slug fall back to the current form value (the WP
      // prefill) when the snapshot didn't capture them, so hydrating an older
      // snapshot never clears a known author/category/slug.
      wp_author_id: s.wp_author_id ?? f.wp_author_id ?? null,
      wp_category_ids: s.wp_category_ids ?? f.wp_category_ids ?? null,
      wp_tag_ids: s.wp_tag_ids ?? null,
      wp_featured_media_id: s.wp_featured_media_id ?? null,
      wp_slug: s.wp_slug ?? f.wp_slug ?? null,
      wp_excerpt: s.wp_excerpt ?? null,
      wp_publish_at: s.wp_publish_at ?? null,
    }));
  }, [setComments]);

  const { saveState, isDirty, saveStatusLabel, saveSnapshot, handleManualSave } =
    useSnapshotAutosave({
      runId,
      ready: renderReady,
      snapshotIn,
      baselineKey,
      editorEmailRef,
      submittedRef,
      hydrateEnabled: true,
      hydratedFromSnapshotRef,
      onHydrate: applySnapshot,
      collabActive,
      flattenBody,
    });

  // Restoring first preserves current work, then loads the chosen version.
  // Modelled as a mutation so the version-history Restore buttons can disable
  // and show "Restoring…" while the save round-trips, preventing double-fires.
  const restore = useMutation({
    mutationFn: async (s: Hitl2Snapshot) => {
      await saveSnapshot("manual");
      return s;
    },
    onSuccess: (s) => {
      applySnapshot(s);
      setHistoryOpen(false);
      toast.success(`Restored version from ${new Date(s.created_at).toLocaleString()}`);
    },
    onError: () => toast.error("Couldn't restore — try again"),
  });

  return (
    <RunEditorShell
      runId={runId}
      run={run.data}
      kicker={
        <>
          Galley Proof · Stage 2 · <span className="text-accent">{shortId}</span>
          {existingPost.data?.wp_post_id != null && (
            <>
              {" · "}
              <ExternalLink
                href={existingPost.data.link ?? "#"}
                className="text-accent hover:underline"
              >
                WP #{existingPost.data.wp_post_id} ↗
              </ExternalLink>
              <button
                type="button"
                onClick={handleRereadClick}
                disabled={refresh.isPending}
                className="ml-2 font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider disabled:opacity-50"
              >
                {refresh.isPending ? "↻ Reading…" : "↻ Re-read from WP"}
              </button>
            </>
          )}
        </>
      }
      hed="Editor's review"
      dek="Final pass on the draft. Approve and push to WordPress as draft, request changes, or reject."
      headerActions={
        <RunEditorHeaderActions
          saveStatusLabel={saveStatusLabel}
          saveState={saveState}
          isDirty={isDirty}
          canEdit={canEdit}
          onSave={handleManualSave}
          onOpenHistory={() => setHistoryOpen(true)}
        />
      }
      actionBar={
        gateResolved ? (
          <>
            <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint mr-auto">
              Gate resolved · run is now{" "}
              <span className="text-ink">{run.data?.status}</span> — draft review is read-only.
            </span>
            <Link
              href={`/runs/${runId}/edit`}
              className="font-mono text-[11px] uppercase tracking-wider text-accent hover:text-ink"
            >
              Edit &amp; re-push →
            </Link>
          </>
        ) : (
          <>
            <RoleButton
              need="hitl2_decide"
              deniedHint="Reviewer role required to reject."
              variant="destructive"
              size="sm"
              disabled={!renderReady || submit.isPending || !atGate}
              onClick={() => submit.mutate("reject")}
            >
              {submit.isPending && submit.variables === "reject" ? "↻ Rejecting…" : "Reject ✕"}
            </RoleButton>
            <RoleButton
              need="publish"
              deniedHint="Reviewer role required to approve and publish."
              variant="primary"
              disabled={!renderReady || submit.isPending || !atGate}
              onClick={() => submit.mutate("approve")}
            >
              {submit.isPending && submit.variables === "approve"
                ? "↻ Pushing to WP…"
                : "Approve & push to WP ↪"}
            </RoleButton>
          </>
        )
      }
    >
      {/* Galley column */}
      <section>
          <Tabs
            value={galleyTab}
            onValueChange={(v) => {
              const next = v as typeof galleyTab;
              setGalleyTab(next);
              if (next === "payload") wpPayload.onTabOpen(renderReady);
            }}
          >
            <TabsList className="border-b border-rule">
              <TabsTrigger value="edit">Edit</TabsTrigger>
              <TabsTrigger value="diff">Diff vs render</TabsTrigger>
              <TabsTrigger value="audit">Audit findings</TabsTrigger>
              <TabsTrigger value="raw">Raw HTML</TabsTrigger>
              <TabsTrigger value="payload">WP payload</TabsTrigger>
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
                <ArticleEditor
                  html={html}
                  committedHtml={committedHtml}
                  pendingCount={pendingChanges}
                  onHtmlChange={setHtml}
                  onTrackedChange={({ committed, working }) => {
                    setCommittedHtml(committed);
                    setHtml(working);
                  }}
                  onComment={commentOnChange}
                  onAddComment={addComment}
                  onCommentClick={focusComment}
                  onAddReviewNote={onAddReviewNote}
                  onReviewClick={onReviewClick}
                  collab={collab}
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
            <TabsContent value="raw" className="pt-6">
              <RawHtmlView html={html} />
            </TabsContent>
            <TabsContent value="payload" className="pt-6">
              <WpPayloadView
                payload={wpPayload.payload}
                isPending={wpPayload.isPending}
                isError={wpPayload.isError}
                errorMessage={wpPayload.error?.message}
                onRefresh={wpPayload.build}
                canRefresh={renderReady}
              />
            </TabsContent>
          </Tabs>
        </section>

        {/* Right rail — WP metadata ↔ "AI to edit" tab switcher */}
        <EditorRail
          tab={rightTab}
          onTabChange={setRightTab}
          form={form}
          onFormChange={setForm}
          runId={runId}
          existingAuthorName={existingPost.data?.wp_author_name ?? null}
          existingCategoryName={existingPost.data?.wp_category_name ?? null}
          comments={comments}
          focusedCommentId={focusedCommentId}
          onCommentChange={updateComment}
          onCommentDelete={deleteComment}
          onCommentFocus={focusComment}
          notesValue={form.notes ?? ""}
          onNotesChange={(v) => setForm((f) => ({ ...f, notes: v }))}
          onRequestEdit={requestAiEdit}
          requesting={requesting}
          requestEnabled={requestEnabled}
          reviewPanel={<ReviewPanel rt={reviewThreads} />}
          reviewCount={reviewThreads.threads.length}
        />

      <Hitl2VersionHistory
        runId={runId}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestore={(s) => restore.mutate(s)}
        restoring={restore.isPending}
        restoringId={restore.variables?.snapshot_id ?? null}
      />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-read from WordPress?</DialogTitle>
            <DialogDescription>
              This will overwrite your edits to: {dirtyFields.join(", ")}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmOpen(false);
                refresh.mutate();
              }}
            >
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RunEditorShell>
  );
}
