"use client";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { RoleButton } from "@/components/RoleGate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OutlineEditor } from "@/components/OutlineEditor";
import { TipTapEditor } from "@/components/TipTapEditor";
import { RawHtmlView } from "@/components/RawHtmlView";
import { WpPayloadView } from "@/components/WpPayloadView";
import { Hitl2VersionHistory } from "@/components/Hitl2VersionHistory";
import { RunEditorShell } from "@/components/run-editor/RunEditorShell";
import { EditorRail } from "@/components/run-editor/EditorRail";
import { useArticleComments } from "@/lib/useArticleComments";
import { useApplyEdits } from "@/lib/useApplyEdits";
import { stripCommentSpan } from "@/lib/comment-anchor";
import {
  applySnapshotToForm,
  buildArticlePayload,
  buildDryRequest,
  buildSnapshotIn,
  snapshotKey,
} from "@/lib/run-editor/form";
import { useWpPayloadPreview } from "@/lib/run-editor/useWpPayloadPreview";
import { useSnapshotAutosave } from "@/lib/run-editor/useSnapshotAutosave";
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
import type { Hitl2Request, Hitl2Snapshot, Hitl2SnapshotIn, Outline } from "@/lib/types";

type EditTab = "article" | "outline" | "raw" | "payload";

export default function EditRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();
  const qc = useQueryClient();

  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId) });
  const outlineQ = useQuery({ queryKey: ["outline", runId], queryFn: () => api.getOutline(runId) });
  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });
  const existingPost = useQuery({
    queryKey: ["existing-post", runId],
    queryFn: () => api.getExistingPost(runId),
    retry: false, // 404 is expected on the create / new-post path
  });

  const [tab, setTab] = useState<EditTab>("article");
  const [outline, setOutline] = useState<Outline | null>(null);
  const [outlineDirty, setOutlineDirty] = useState(false);
  const [html, setHtml] = useState("");
  const [form, setForm] = useState<Hitl2Request>({ decision: "approve", wp_publish_status: "draft" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"wp" | "comments">("wp");
  const wpPrefilledRef = useRef(false);
  const renderSeededRef = useRef(false);
  const hydratedFromSnapshotRef = useRef(false);
  // Set once a re-push navigates away, so the exit-flush doesn't double-save.
  const submittedRef = useRef(false);

  const { can } = useRole();
  const canEdit = can("edit_article");
  const { data: session } = useSession();
  const editorEmail = session?.user?.email ?? "";
  const editorEmailRef = useRef(editorEmail);
  useEffect(() => {
    editorEmailRef.current = editorEmail;
  }, [editorEmail]);

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
  const { requestEdit, requesting } = useApplyEdits(runId, {
    onApplied: (newHtml, ctx) => {
      if (ctx.commentIds.length > 0) {
        // Strip the addressed comments' anchor spans and drop them from the list.
        const cleaned = ctx.commentIds.reduce(stripCommentSpan, newHtml);
        const sent = new Set(ctx.commentIds);
        setHtml(cleaned);
        setComments((cs) => cs.filter((c) => !sent.has(c.id)));
        setFocusedCommentId((f) => (f && sent.has(f) ? null : f));
      } else {
        setHtml(newHtml);
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

  // Seed the outline editor from the human-edited copy when present, else the
  // original AI payload.
  useEffect(() => {
    if (outlineQ.data && outline === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOutline(outlineQ.data.human_edits ?? outlineQ.data.payload);
    }
  }, [outlineQ.data, outline]);

  // Seed the article body + SEO fields from the latest render exactly once, so a
  // later refetch (e.g. after Save invalidates the query) can't re-clobber the
  // operator's in-progress edits or race the WP-metadata prefill below.
  useEffect(() => {
    if (!render.data || renderSeededRef.current) return;
    if (hydratedFromSnapshotRef.current) return; // a saved snapshot owns the body
    renderSeededRef.current = true;
    setHtml(render.data.html_body);
    setForm((f) => ({
      ...f,
      edited_seo_title: render.data!.seo_title,
      edited_meta_description: render.data!.meta_description,
      wp_excerpt: f.wp_excerpt ?? render.data!.excerpt_suggestion,
    }));
  }, [render.data]);

  // Prefill WP metadata once, after both the run and the existing-post probe
  // have settled. The run row is the primary source — it carries the operator's
  // last-selected author / categories for BOTH create and refresh runs. The
  // existing WP post only fills gaps (legacy refresh runs that never persisted
  // their metadata) and supplies the human-readable name fallbacks.
  const existingPostSettled = existingPost.isSuccess || existingPost.isError;
  useEffect(() => {
    if (!run.data || !existingPostSettled || wpPrefilledRef.current) return;
    wpPrefilledRef.current = true;
    const r = run.data;
    const ep = existingPost.data;
    setForm((f) => ({
      ...f,
      wp_publish_status: r.wp_publish_status ?? f.wp_publish_status ?? "draft",
      wp_author_id: r.wp_author_id ?? ep?.wp_author_id ?? null,
      wp_category_ids:
        r.wp_category_ids ?? (ep?.wp_category_id != null ? [ep.wp_category_id] : null),
      wp_tag_ids: r.wp_tag_ids ?? null,
      wp_featured_media_id: r.wp_featured_media_id ?? null,
      wp_slug: r.wp_slug ?? ep?.wp_slug ?? null,
      wp_excerpt: r.wp_excerpt ?? f.wp_excerpt ?? null,
    }));
  }, [run.data, existingPost.data, existingPostSettled]);

  const snapshotIn = useMemo<Hitl2SnapshotIn>(
    () => buildSnapshotIn(html, form, comments, "manual"),
    [html, form, comments],
  );

  // Clean baseline mirrors the render seed (body + SEO) and the WP-metadata
  // prefill (run row first, existing post as fallback), so a freshly-loaded
  // editor never reads as dirty before a real edit.
  const baselineKey = useMemo(() => {
    if (!render.data || !existingPostSettled) return null;
    const r = run.data;
    const ep = existingPost.data;
    return snapshotKey({
      trigger: "manual",
      html_body: render.data.html_body,
      seo_title: render.data.seo_title,
      meta_description: render.data.meta_description,
      notes: null,
      comments: [],
      wp_publish_status: r?.wp_publish_status ?? "draft",
      wp_author_id: r?.wp_author_id ?? ep?.wp_author_id ?? null,
      wp_category_ids:
        r?.wp_category_ids ?? (ep?.wp_category_id != null ? [ep.wp_category_id] : null),
      wp_tag_ids: r?.wp_tag_ids ?? null,
      wp_featured_media_id: r?.wp_featured_media_id ?? null,
      wp_slug: r?.wp_slug ?? ep?.wp_slug ?? null,
      wp_excerpt: r?.wp_excerpt ?? render.data.excerpt_suggestion ?? null,
      wp_publish_at: null,
    });
  }, [render.data, run.data, existingPost.data, existingPostSettled]);

  const applySnapshot = useCallback((s: Hitl2Snapshot) => {
    setHtml(s.html_body);
    setComments(s.comments ?? []);
    setForm((f) => applySnapshotToForm(f, s));
  }, [setComments]);

  const { saveState, isDirty, saveStatusLabel, saveSnapshot, handleManualSave } =
    useSnapshotAutosave({
      runId,
      ready: render.data !== undefined,
      snapshotIn,
      baselineKey,
      editorEmailRef,
      submittedRef,
      hydrateEnabled: true,
      hydratedFromSnapshotRef,
      onHydrate: applySnapshot,
    });

  async function persist() {
    if (outline && outlineDirty) await api.saveOutline(runId, outline);
    await api.saveArticle(runId, buildArticlePayload(html, form));
    // Capture a version-history snapshot so each save is recoverable, mirroring
    // the HITL_2 gate's autosave history. Routed through the autosave hook so the
    // header's dirty indicator clears; the hook swallows snapshot failures so they
    // never fail the save itself.
    await saveSnapshot("manual");
    qc.invalidateQueries({ queryKey: ["render", runId] });
    qc.invalidateQueries({ queryKey: ["outline", runId] });
  }

  const save = useMutation({
    mutationFn: persist,
    onSuccess: () => toast.success("Saved changes"),
    onError: (e: Error) => toast.error(`Save failed — ${e.message}`),
  });

  // WP payload preview for the "WP payload" tab — reflects the current unsaved
  // edits (does not persist). Mirrors the HITL_2 dry-publish preview.
  const wpPayload = useWpPayloadPreview(runId, () => buildDryRequest(html, form));

  // Save → build the dry-publish preview → open the confirm dialog so the
  // operator verifies target_label before any write to WordPress.
  const prepublish = useMutation({
    mutationFn: async () => {
      await persist();
      return api.dryPublish(runId, buildDryRequest(html, form));
    },
    // Feed the shared preview state so the WP-payload tab and this dialog read
    // the same payload (single source of truth, as the pre-refactor page did).
    onSuccess: (data) => {
      wpPayload.setPayload(data);
      setConfirmOpen(true);
    },
    onError: (e: Error) => toast.error(`Couldn't prepare re-push — ${e.message}`),
  });

  const republish = useMutation({
    mutationFn: () => api.republish(runId),
    onSuccess: (res) => {
      submittedRef.current = true; // re-push already persisted; skip the exit-flush
      setConfirmOpen(false);
      toast.success(`Re-pushed to WordPress (post #${res.wp_post_id})`);
      qc.invalidateQueries({ queryKey: ["run", runId] });
      router.push(`/runs/${runId}`);
    },
    onError: (e: Error) => toast.error(`Re-push failed — ${e.message}`),
  });

  const restore = useMutation({
    mutationFn: async (snapshot: Hitl2Snapshot) => {
      // Preserve the current state before overwriting, then hydrate.
      await saveSnapshot("manual");
      return snapshot;
    },
    onSuccess: (snapshot) => {
      applySnapshot(snapshot);
      setHistoryOpen(false);
      toast.success("Restored version — review, then Save to keep it");
    },
    onError: (e: Error) => toast.error(`Restore failed — ${e.message}`),
    onSettled: () => setRestoringId(null),
  });

  const isBusy = save.isPending || prepublish.isPending || republish.isPending;
  const renderMissing = render.isError;
  const renderReady = render.data !== undefined;

  function onTabChange(next: string) {
    setTab(next as EditTab);
    // Lazily build the WP payload the first time the operator opens that tab.
    if (next === "payload" && !wpPayload.payload) wpPayload.onTabOpen(renderReady);
  }

  return (
    <RunEditorShell
      runId={runId}
      run={run.data}
      kicker={<>Edit · <span className="text-accent">{shortId}</span></>}
      hed="Edit outline & article"
      dek="Revise a finished run's outline and article, then save — or save and re-push the article to WordPress."
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
        <>
          <RoleButton
            need="edit_article"
            deniedHint="Author role required to save changes."
            variant="secondary"
            disabled={isBusy}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </RoleButton>
          <RoleButton
            need="publish"
            deniedHint="Reviewer role required to re-push to WordPress."
            variant="primary"
            disabled={isBusy || renderMissing}
            onClick={() => prepublish.mutate()}
          >
            {prepublish.isPending ? "Preparing…" : "Save & re-push to WordPress ↪"}
          </RoleButton>
        </>
      }
    >
      <section>
          <Tabs value={tab} onValueChange={onTabChange}>
            <TabsList className="border-b border-rule">
              <TabsTrigger value="article">Article</TabsTrigger>
              <TabsTrigger value="outline">Outline</TabsTrigger>
              <TabsTrigger value="raw">Raw HTML</TabsTrigger>
              <TabsTrigger value="payload">WP payload</TabsTrigger>
            </TabsList>
            <TabsContent value="article" className="pt-6">
              {render.isPending && (
                <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider animate-pulse">
                  Loading article…
                </p>
              )}
              {renderMissing && (
                <p className="font-mono text-[12px] text-ink-soft">
                  No rendered article exists for this run yet — only the outline is editable.
                </p>
              )}
              {render.data && (
                <TipTapEditor
                  value={html}
                  onChange={setHtml}
                  onAddComment={addComment}
                  onCommentClick={focusComment}
                />
              )}
            </TabsContent>
            <TabsContent value="outline" className="pt-6">
              {outlineQ.isPending && (
                <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider animate-pulse">
                  Loading outline…
                </p>
              )}
              {outlineQ.isError && (
                <p className="font-mono text-[12px] text-ink-soft">
                  No outline exists for this run.
                </p>
              )}
              {outline && (
                <OutlineEditor
                  outline={outline}
                  onChange={(o) => {
                    setOutline(o);
                    setOutlineDirty(true);
                  }}
                />
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

        <EditorRail
          tab={rightTab}
          onTabChange={setRightTab}
          form={form}
          onFormChange={setForm}
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
        />

      <Hitl2VersionHistory
        runId={runId}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestore={(s) => {
          setRestoringId(s.snapshot_id);
          restore.mutate(s);
        }}
        restoring={restore.isPending}
        restoringId={restoringId}
      />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-push to WordPress?</DialogTitle>
            <DialogDescription>
              {wpPayload.payload ? (
                <>
                  This overwrites the live post on{" "}
                  <span className="font-mono text-ink">{wpPayload.payload.target_label}</span>{" "}
                  ({wpPayload.payload.target_base_url}) via{" "}
                  <span className="font-mono text-ink">
                    {wpPayload.payload.request_method} {wpPayload.payload.request_url}
                  </span>
                  . Changes are already saved.
                </>
              ) : (
                "Preparing payload…"
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={republish.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => republish.mutate()} disabled={republish.isPending}>
              {republish.isPending ? "Pushing…" : "Confirm re-push"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RunEditorShell>
  );
}
