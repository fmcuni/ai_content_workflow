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
  DryPublishResponse,
  ExistingPost,
  Hitl2Request,
  Outline,
} from "@/lib/types";

export default function EditRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();
  const qc = useQueryClient();

  const outlineQ = useQuery({ queryKey: ["outline", runId], queryFn: () => api.getOutline(runId) });
  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });
  const existingPost = useQuery({
    queryKey: ["existing-post", runId],
    queryFn: () => api.getExistingPost(runId),
    retry: false, // 404 is expected on the create / new-post path
  });

  const [outline, setOutline] = useState<Outline | null>(null);
  const [outlineDirty, setOutlineDirty] = useState(false);
  const [html, setHtml] = useState("");
  const [form, setForm] = useState<Hitl2Request>({ decision: "approve", wp_publish_status: "draft" });
  const [dryPayload, setDryPayload] = useState<DryPublishResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const prefilledRef = useRef<ExistingPost | null>(null);

  // Seed the outline editor from the human-edited copy when present, else the
  // original AI payload.
  useEffect(() => {
    if (outlineQ.data && outline === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOutline(outlineQ.data.human_edits ?? outlineQ.data.payload);
    }
  }, [outlineQ.data, outline]);

  // Seed the article body + SEO fields from the latest render.
  useEffect(() => {
    if (render.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHtml(render.data.html_body);
      setForm((f) => ({
        ...f,
        edited_seo_title: render.data!.seo_title,
        edited_meta_description: render.data!.meta_description,
        wp_excerpt: f.wp_excerpt ?? render.data!.excerpt_suggestion,
      }));
    }
  }, [render.data]);

  // Prefill WP author / category / slug from the existing post once.
  useEffect(() => {
    if (!existingPost.data || prefilledRef.current !== null) return;
    prefilledRef.current = existingPost.data;
    const ep = existingPost.data;
    setForm((f) => ({
      ...f,
      wp_author_id: ep.wp_author_id,
      wp_category_ids: ep.wp_category_id != null ? [ep.wp_category_id] : null,
      wp_slug: ep.wp_slug,
    }));
  }, [existingPost.data]);

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

  async function persist() {
    if (outline && outlineDirty) await api.saveOutline(runId, outline);
    await api.saveArticle(runId, buildArticlePayload());
    qc.invalidateQueries({ queryKey: ["render", runId] });
    qc.invalidateQueries({ queryKey: ["outline", runId] });
  }

  const save = useMutation({
    mutationFn: persist,
    onSuccess: () => toast.success("Saved changes"),
    onError: (e: Error) => toast.error(`Save failed — ${e.message}`),
  });

  // Save → build the dry-publish preview → open the confirm dialog so the
  // operator verifies target_label before any write to WordPress.
  const prepublish = useMutation({
    mutationFn: async () => {
      await persist();
      return api.dryPublish(runId, buildArticlePayload());
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

  const isBusy = save.isPending || prepublish.isPending || republish.isPending;
  const renderMissing = render.isError;

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
          <Tabs defaultValue="article">
            <TabsList className="border-b border-rule">
              <TabsTrigger value="article">Article</TabsTrigger>
              <TabsTrigger value="outline">Outline</TabsTrigger>
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
