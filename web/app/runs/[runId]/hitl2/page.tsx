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
import { TipTapEditor } from "@/components/TipTapEditor";
import { HtmlDiffView } from "@/components/HtmlDiffView";
import { RunEditorShell } from "@/components/run-editor/RunEditorShell";
import { EditorRail } from "@/components/run-editor/EditorRail";
import { NotesToAi } from "@/components/run-editor/NotesToAi";
import { Hitl2VersionHistory } from "@/components/Hitl2VersionHistory";
import { RawHtmlView } from "@/components/RawHtmlView";
import { WpPayloadView } from "@/components/WpPayloadView";
import { useArticleComments } from "@/lib/useArticleComments";
import { useApplyEdits } from "@/lib/useApplyEdits";
import { stripCommentSpan } from "@/lib/comment-anchor";
import {
  buildDryRequest,
  buildSnapshotIn,
  isBlankBody,
  snapshotInFromSaved,
  snapshotKey,
} from "@/lib/run-editor/form";
import { useWpPayloadPreview } from "@/lib/run-editor/useWpPayloadPreview";
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
import type {
  ExistingPost,
  Hitl2Request,
  Hitl2Snapshot,
  Hitl2SnapshotIn,
  Hitl2SnapshotTrigger,
} from "@/lib/types";

const MAX_ROUNDS = 3;
const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

export default function Hitl2Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();

  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });
  const audit = useQuery({ queryKey: ["audit", runId], queryFn: () => api.getLatestAudit(runId) });
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId) });

  const qc = useQueryClient();

  // Editing the draft (manual save, apply-edits, regenerate) is an author-level
  // capability; the approve/reject/request-changes gate is reviewer-level below.
  const { can } = useRole();
  const canEdit = can("edit_article");

  // Authenticated approver/author identity (email) sent with HITL_2 decisions and
  // snapshots for the audit trail. Mirrored into a ref so the autosave/beacon
  // handlers (which run outside render) read the latest without re-subscribing.
  const { data: session } = useSession();
  const editorEmail = session?.user?.email ?? "";
  const editorEmailRef = useRef(editorEmail);
  useEffect(() => {
    editorEmailRef.current = editorEmail;
  }, [editorEmail]);

  const existingPost = useQuery({
    queryKey: ["existing-post", runId],
    queryFn: () => api.getExistingPost(runId),
    retry: false, // 404 is expected on the new-post path
  });

  const prefilledRef = useRef<ExistingPost | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Set once a HITL_2 decision is submitted, so autosave-on-exit doesn't write a
  // redundant snapshot as the page navigates away after approve/request/reject.
  const submittedRef = useRef(false);
  // Hydration runs once, after the snapshot list resolves. When a saved snapshot
  // exists it seeds the editor and these refs stop the render/WP prefills from
  // clobbering the restored work.
  const hydrationDoneRef = useRef(false);
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
    if (getDirtyFields().length === 0) {
      refresh.mutate();
    } else {
      setConfirmOpen(true);
    }
  }

  const [html, setHtml] = useState<string>("");
  const [form, setForm] = useState<Hitl2Request>({ decision: "approve", wp_publish_status: "draft" });
  const [originalHtml, setOriginalHtml] = useState("");
  const [rightTab, setRightTab] = useState<"wp" | "comments">("wp");
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
  const { applyComment, applyNotes, applyingCommentId } = useApplyEdits(runId, {
    onCommentApplied: (commentId, newHtml) => {
      setHtml(stripCommentSpan(newHtml, commentId));
      setComments((cs) => cs.filter((c) => c.id !== commentId));
      setFocusedCommentId((f) => (f === commentId ? null : f));
    },
    onNotesApplied: (newHtml) => {
      setHtml(newHtml);
      setForm((f) => ({ ...f, notes: "" }));
    },
  });
  const [galleyTab, setGalleyTab] = useState<"edit" | "diff" | "audit" | "raw" | "payload">("edit");
  const wpPayload = useWpPayloadPreview(runId, () => buildDryRequest(html, form));

  useEffect(() => {
    if (render.data) {
      // Diff baseline is always the pristine render, even when restoring a snapshot.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOriginalHtml(render.data.html_body);
      if (hydratedFromSnapshotRef.current) return; // snapshot owns the editor body
      setHtml(render.data.html_body);
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
    if (hydratedFromSnapshotRef.current) return; // snapshot already set the form
    const ep = existingPost.data;
    setForm((f) => ({
      ...f,
      wp_author_id: ep.wp_author_id,
      wp_category_ids: ep.wp_category_id != null ? [ep.wp_category_id] : null,
      wp_slug: ep.wp_slug,
    }));
  }, [existingPost.data]);

  const renderReady = Boolean(render.data);
  // Reachable by direct URL / bookmark even after the draft gate is resolved
  // (e.g. an already-published run). Only allow the live Reject / Request-changes
  // / Approve actions while the run is genuinely paused at HITL_2.
  const atGate = run.data?.status === "hitl_2";
  const gateResolved = run.data != null && !atGate;
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
        editor_email: editorEmail,
      });
    },
    onSuccess: () => {
      submittedRef.current = true;
      router.push(`/runs/${runId}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // --- Autosave + version history -----------------------------------------
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const snapshotIn = useMemo<Hitl2SnapshotIn>(
    () => buildSnapshotIn(html, form, comments, "manual"),
    [html, form, comments],
  );
  const currentKey = useMemo(() => snapshotKey(snapshotIn), [snapshotIn]);

  // Baseline is derived from the same source data the prefill effects consume,
  // so a freshly-loaded page never reads as dirty before any real edit.
  const baselineKey = useMemo(() => {
    if (!render.data || !existingPost.isFetched) return null;
    return snapshotKey({
      trigger: "manual",
      html_body: render.data.html_body,
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

  // `lastSavedKey` drives the dirty indicator (state, read during render);
  // `lastSavedKeyRef` mirrors it for the unmount / pagehide handlers that run
  // outside render and must see the latest value without re-subscribing.
  const [lastSavedKey, setLastSavedKey] = useState<string | null>(null);
  const lastSavedKeyRef = useRef<string | null>(null);
  const snapshotRef = useRef(snapshotIn);
  useEffect(() => {
    snapshotRef.current = snapshotIn;
  });
  useEffect(() => {
    lastSavedKeyRef.current = lastSavedKey;
  }, [lastSavedKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (baselineKey != null && lastSavedKey == null) setLastSavedKey(baselineKey);
  }, [baselineKey, lastSavedKey]);

  const isDirty = lastSavedKey != null && currentKey !== lastSavedKey;

  const saveSnapshot = useCallback(
    async (trigger: Hitl2SnapshotTrigger): Promise<"saved" | "unchanged" | "error"> => {
      if (submittedRef.current || lastSavedKeyRef.current == null) return "unchanged";
      const snap = snapshotRef.current;
      // Never persist a blank body — TipTap reports empty mid-teardown, and a
      // blank save would overwrite good work and reload to an empty editor.
      if (isBlankBody(snap.html_body)) return "unchanged";
      const key = snapshotKey(snap);
      if (key === lastSavedKeyRef.current) return "unchanged"; // nothing changed
      try {
        setSaveState("saving");
        await api.saveHitl2Snapshot(runId, { ...snap, trigger, editor_email: editorEmailRef.current });
        lastSavedKeyRef.current = key;
        setLastSavedKey(key);
        setSavedAt(new Date());
        setSaveState("saved");
        qc.invalidateQueries({ queryKey: ["hitl2-snapshots", runId] });
        return "saved";
      } catch {
        setSaveState("error");
        return "error";
      }
    },
    [runId, qc],
  );

  const handleManualSave = useCallback(async () => {
    const result = await saveSnapshot("manual");
    if (result === "saved") toast.success("Saved version");
    else if (result === "error") toast.error("Couldn't save — try again");
    else toast("Already up to date");
  }, [saveSnapshot]);

  // Every 5 minutes, persist a snapshot if anything changed.
  useEffect(() => {
    const id = setInterval(() => void saveSnapshot("interval"), AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [saveSnapshot]);

  // Leaving the page — client-side nav, link click, or unmount — flushes a save.
  useEffect(() => () => void saveSnapshot("navigate"), [saveSnapshot]);

  // Tab close / reload: an awaited fetch would be cancelled, so beacon instead.
  useEffect(() => {
    const handler = () => {
      if (submittedRef.current || lastSavedKeyRef.current == null) return;
      const snap = snapshotRef.current;
      if (isBlankBody(snap.html_body)) return;
      if (snapshotKey(snap) === lastSavedKeyRef.current) return;
      api.beaconHitl2Snapshot(runId, { ...snap, trigger: "unload", editor_email: editorEmailRef.current });
    };
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  }, [runId]);

  const applySnapshot = useCallback((s: Hitl2Snapshot) => {
    setHtml(s.html_body);
    setComments(s.comments ?? []);
    setForm((f) => ({
      ...f,
      notes: s.notes ?? undefined,
      edited_seo_title: s.seo_title ?? null,
      edited_meta_description: s.meta_description ?? null,
      wp_publish_status: (s.wp_publish_status as Hitl2Request["wp_publish_status"]) ?? "draft",
      wp_author_id: s.wp_author_id ?? null,
      wp_category_ids: s.wp_category_ids ?? null,
      wp_tag_ids: s.wp_tag_ids ?? null,
      wp_featured_media_id: s.wp_featured_media_id ?? null,
      wp_slug: s.wp_slug ?? null,
      wp_excerpt: s.wp_excerpt ?? null,
      wp_publish_at: s.wp_publish_at ?? null,
    }));
  }, [setComments]);

  // On load, reopen the editor at the most recent saved snapshot (autosave or
  // manual) rather than the pristine render, and treat it as the clean baseline.
  useEffect(() => {
    if (hydrationDoneRef.current || !render.data) return;
    let cancelled = false;
    void (async () => {
      // Pull a FRESH list, not the reactive cache: returning via client-side nav
      // (e.g. from the index page) would otherwise hydrate from a stale cache that
      // predates the navigate-away autosave, loading an older version.
      const list = await qc.fetchQuery({
        queryKey: ["hitl2-snapshots", runId],
        queryFn: () => api.listHitl2Snapshots(runId),
        staleTime: 0,
      });
      // Mark done only after the fetch resolves so StrictMode's double-invoke
      // (which cancels the first pass) doesn't leave hydration permanently skipped.
      if (cancelled || hydrationDoneRef.current) return;
      hydrationDoneRef.current = true;
      // Skip any blank-body rows left by the teardown bug; load the newest real save.
      const latest = list.find((s) => !isBlankBody(s.html_body));
      if (!latest) return;
      hydratedFromSnapshotRef.current = true;
      applySnapshot(latest);
      const key = snapshotKey(snapshotInFromSaved(latest));
      lastSavedKeyRef.current = key;
      setLastSavedKey(key);
      setSavedAt(new Date(latest.created_at));
      setSaveState("saved");
    })();
    return () => {
      cancelled = true;
    };
  }, [render.data, runId, qc, applySnapshot]);

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

  const saveStatusLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "error"
      ? "Autosave failed"
      : isDirty
      ? "Unsaved changes"
      : savedAt
      ? `Saved ${savedAt.toLocaleTimeString()}`
      : "Autosave on";

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
        <div className="flex items-center gap-3">
          <span
            className={`font-mono text-[11px] uppercase tracking-wider ${
              saveState === "error"
                ? "text-accent-deep"
                : isDirty
                ? "text-accent"
                : "text-ink-faint"
            }`}
          >
            {saveState === "saving" && "↻ "}
            {saveStatusLabel}
          </span>
          <button
            type="button"
            onClick={handleManualSave}
            disabled={!isDirty || saveState === "saving" || !canEdit}
            title={!canEdit ? "Author role required to save edits." : undefined}
            className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-ink-faint"
          >
            {saveState === "saving" ? "↻ Saving…" : "⤓ Save"}
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider"
          >
            ⟲ Version history
          </button>
        </div>
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
            {round > 0 && (
              <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint mr-auto">
                Round {round + 1} of {MAX_ROUNDS}
              </span>
            )}
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
              need="hitl2_decide"
              deniedHint="Reviewer role required to request changes."
              variant="secondary"
              size="sm"
              disabled={!renderReady || submit.isPending || capReached || !hasFeedback || !atGate}
              title={
                capReached
                  ? "Cap reached — approve or reject."
                  : !hasFeedback
                  ? "Add a comment or note first."
                  : ""
              }
              onClick={() => submit.mutate("request_changes")}
            >
              {submit.isPending && submit.variables === "request_changes"
                ? "↻ Sending…"
                : "Request changes ↺"}
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

          {/* Notes to AI — overall inline edit of the existing article */}
          <NotesToAi
            value={form.notes ?? ""}
            onChange={(v) => setForm((f) => ({ ...f, notes: v }))}
            onApply={() => applyNotes.mutate({ notes: form.notes ?? "", html })}
            applying={applyNotes.isPending}
          />
        </section>

        {/* Right rail — WP metadata ↔ Comments tab switcher */}
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
          onCommentApply={(id) => {
            const c = comments.find((x) => x.id === id);
            if (c) applyComment.mutate({ comment: c, html });
          }}
          applyingCommentId={applyingCommentId}
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
              This will overwrite your edits to: {getDirtyFields().join(", ")}.
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
