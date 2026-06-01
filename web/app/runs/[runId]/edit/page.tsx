"use client";
import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionHead } from "@/components/SectionHead";
import { OutlineEditor } from "@/components/OutlineEditor";
import { TipTapEditor } from "@/components/TipTapEditor";
import { WordPressMetaForm } from "@/components/WordPressMetaForm";
import { RawHtmlView } from "@/components/RawHtmlView";
import { WpPayloadView } from "@/components/WpPayloadView";
import { Hitl2VersionHistory } from "@/components/Hitl2VersionHistory";
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
  ArticleEditRequest,
  DryPublishRequest,
  DryPublishResponse,
  Hitl2Request,
  Hitl2Snapshot,
  Hitl2SnapshotIn,
  Hitl2SnapshotTrigger,
  Outline,
} from "@/lib/types";

type EditTab = "article" | "outline" | "raw" | "payload";

const WP_PUBLISH_STATUSES: ReadonlyArray<Hitl2Request["wp_publish_status"]> = [
  "draft",
  "future",
  "publish",
];

/** Narrow a stored status string to the form's union; unknown values → undefined. */
function asPublishStatus(
  value: string | null | undefined,
): Hitl2Request["wp_publish_status"] | undefined {
  return WP_PUBLISH_STATUSES.find((s) => s === value);
}

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
  const [dryPayload, setDryPayload] = useState<DryPublishResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const wpPrefilledRef = useRef(false);
  const renderSeededRef = useRef(false);

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

  function buildArticlePayload(): ArticleEditRequest {
    return {
      html_body: html,
      seo_title: form.edited_seo_title ?? "",
      meta_description: form.edited_meta_description ?? "",
      wp_publish_status: form.wp_publish_status,
      wp_author_id: form.wp_author_id ?? null,
      wp_category_ids: form.wp_category_ids ?? null,
      wp_tag_ids: form.wp_tag_ids ?? null,
      wp_featured_media_id: form.wp_featured_media_id ?? null,
      wp_slug: form.wp_slug ?? null,
      wp_excerpt: form.wp_excerpt ?? null,
      wp_publish_at: form.wp_publish_at ?? null,
    };
  }

  function buildDryRequest(): DryPublishRequest {
    return {
      edited_html_body: html,
      edited_seo_title: form.edited_seo_title ?? null,
      edited_meta_description: form.edited_meta_description ?? null,
      wp_publish_status: form.wp_publish_status,
      wp_author_id: form.wp_author_id ?? null,
      wp_category_ids: form.wp_category_ids ?? null,
      wp_tag_ids: form.wp_tag_ids ?? null,
      wp_featured_media_id: form.wp_featured_media_id ?? null,
      wp_slug: form.wp_slug ?? null,
      wp_excerpt: form.wp_excerpt ?? null,
      wp_publish_at: form.wp_publish_at ?? null,
    };
  }

  function buildSnapshot(trigger: Hitl2SnapshotTrigger): Hitl2SnapshotIn {
    return {
      trigger,
      html_body: html,
      seo_title: form.edited_seo_title ?? null,
      meta_description: form.edited_meta_description ?? null,
      notes: form.notes ?? null,
      comments: form.comments ?? null,
      wp_publish_status: form.wp_publish_status,
      wp_author_id: form.wp_author_id ?? null,
      wp_category_ids: form.wp_category_ids ?? null,
      wp_tag_ids: form.wp_tag_ids ?? null,
      wp_featured_media_id: form.wp_featured_media_id ?? null,
      wp_slug: form.wp_slug ?? null,
      wp_excerpt: form.wp_excerpt ?? null,
      wp_publish_at: form.wp_publish_at ?? null,
    };
  }

  async function persist() {
    if (outline && outlineDirty) await api.saveOutline(runId, outline);
    await api.saveArticle(runId, buildArticlePayload());
    // Capture a version-history snapshot so each save is recoverable, mirroring
    // the HITL_2 gate's autosave history. Best-effort — a snapshot failure must
    // not fail the save itself.
    try {
      await api.saveHitl2Snapshot(runId, buildSnapshot("manual"));
      qc.invalidateQueries({ queryKey: ["hitl2-snapshots", runId] });
    } catch {
      // Swallow: the article + outline are already persisted above.
    }
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
  const dryPublish = useMutation({
    mutationFn: () => api.dryPublish(runId, buildDryRequest()),
    onSuccess: (data) => setDryPayload(data),
    onError: (e: Error) => toast.error(`Couldn't build payload — ${e.message}`),
  });

  // Save → build the dry-publish preview → open the confirm dialog so the
  // operator verifies target_label before any write to WordPress.
  const prepublish = useMutation({
    mutationFn: async () => {
      await persist();
      return api.dryPublish(runId, buildDryRequest());
    },
    onSuccess: (data) => {
      setDryPayload(data);
      setConfirmOpen(true);
    },
    onError: (e: Error) => toast.error(`Couldn't prepare re-push — ${e.message}`),
  });

  const republish = useMutation({
    mutationFn: () => api.republish(runId),
    onSuccess: (res) => {
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
      await api.saveHitl2Snapshot(runId, buildSnapshot("manual"));
      return snapshot;
    },
    onSuccess: (snapshot) => {
      setHtml(snapshot.html_body);
      setForm((f) => ({
        ...f,
        edited_seo_title: snapshot.seo_title ?? f.edited_seo_title,
        edited_meta_description: snapshot.meta_description ?? f.edited_meta_description,
        notes: snapshot.notes ?? f.notes,
        comments: snapshot.comments ?? f.comments,
        wp_publish_status: asPublishStatus(snapshot.wp_publish_status) ?? f.wp_publish_status,
        wp_author_id: snapshot.wp_author_id ?? null,
        wp_category_ids: snapshot.wp_category_ids ?? null,
        wp_tag_ids: snapshot.wp_tag_ids ?? null,
        wp_featured_media_id: snapshot.wp_featured_media_id ?? null,
        wp_slug: snapshot.wp_slug ?? null,
        wp_excerpt: snapshot.wp_excerpt ?? null,
        wp_publish_at: snapshot.wp_publish_at ?? null,
      }));
      qc.invalidateQueries({ queryKey: ["hitl2-snapshots", runId] });
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
    if (next === "payload" && !dryPayload && !dryPublish.isPending && renderReady) {
      dryPublish.mutate();
    }
  }

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
        kicker={<>Edit · <span className="text-accent">{shortId}</span></>}
        hed="Edit outline & article"
        dek="Revise a finished run's outline and article, then save — or save and re-push the article to WordPress."
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
        <section>
          <Tabs value={tab} onValueChange={onTabChange}>
            <div className="flex items-center justify-between border-b border-rule">
              <TabsList>
                <TabsTrigger value="article">Article</TabsTrigger>
                <TabsTrigger value="outline">Outline</TabsTrigger>
                <TabsTrigger value="raw">Raw HTML</TabsTrigger>
                <TabsTrigger value="payload">WP payload</TabsTrigger>
              </TabsList>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider px-2"
              >
                ⟲ Version history
              </button>
            </div>
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
                <TipTapEditor value={html} onChange={setHtml} />
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
                payload={dryPayload}
                isPending={dryPublish.isPending}
                isError={dryPublish.isError}
                errorMessage={(dryPublish.error as Error | null)?.message}
                onRefresh={() => dryPublish.mutate()}
                canRefresh={renderReady}
              />
            </TabsContent>
          </Tabs>
        </section>

        <aside className="lg:sticky lg:top-[6.25rem] self-start lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto">
          <p className="kicker mb-3">WP metadata</p>
          <Card variant="editorial" className="px-5 py-5">
            <WordPressMetaForm
              form={form}
              onChange={setForm}
              existingAuthorName={existingPost.data?.wp_author_name ?? null}
              existingCategoryName={existingPost.data?.wp_category_name ?? null}
            />
          </Card>
        </aside>
      </div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 bg-paper/95 backdrop-blur border-t border-ink z-40">
        <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-3 flex items-center justify-end gap-3">
          <Button variant="secondary" disabled={isBusy} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
          <Button
            variant="primary"
            disabled={isBusy || renderMissing}
            onClick={() => prepublish.mutate()}
          >
            {prepublish.isPending ? "Preparing…" : "Save & re-push to WordPress ↪"}
          </Button>
        </div>
      </div>

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
              {dryPayload ? (
                <>
                  This overwrites the live post on{" "}
                  <span className="font-mono text-ink">{dryPayload.target_label}</span>{" "}
                  ({dryPayload.target_base_url}) via{" "}
                  <span className="font-mono text-ink">
                    {dryPayload.request_method} {dryPayload.request_url}
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
    </div>
  );
}
