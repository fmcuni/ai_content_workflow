"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useWpCategories, useWpUsers } from "@/lib/use-wp-options";
import type { Hitl2Request, Persona, PublishTarget, RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

import { BriefColumn } from "./BriefColumn";
import { CmsForm } from "./CmsForm";
import { DraftPreview } from "./DraftPreview";
import { decodeSlug, resolveTarget, voiceName } from "./fmt";
import { GapPanel } from "./GapPanel";
import { OutlinePanel } from "./OutlinePanel";
import { StatusPill } from "./StatusPill";
import { useCmsAutosave } from "./useCmsAutosave";
import { RUNS_LIST_KEY } from "./useLedgerData";

export interface DrawerPerms {
  canEditMeta: boolean; // author — SEO/meta snapshot autosave
  canPatch: boolean; // reviewer — destination PATCH
  canPublish: boolean; // reviewer — HITL_2 approve/reject
  canApproveOutline: boolean; // reviewer — HITL_1 approve/reject
  canRestart: boolean; // author — restart failed/rejected
  canRepublish: boolean; // reviewer — republish published
}

interface RunDrawerProps {
  run: RunSummary;
  personaBySlug: Map<string, Persona>;
  targetById: Map<string, PublishTarget>;
  editorEmail: string;
  perms: DrawerPerms;
  onClose: () => void;
  onStep: (delta: number) => void;
}

const NAV_BTN =
  "grid size-[26px] place-items-center rounded-md border border-rule bg-paper text-ink-soft hover:bg-paper-deep disabled:opacity-40";

/**
 * Bottom-sheet run drawer (spec §4.5). Mounted only while a run is open (parent
 * keys it by run_id), so the data hooks always have a concrete run. Two modes:
 * outlined (`hitl_1` → gap analysis + outline + approve/reject) and default
 * (SERP draft preview + CMS-destination form + status-dependent actions, with
 * the dry-publish `target_label` confirm preserved before approve-publish).
 */
export function RunDrawer({
  run,
  personaBySlug,
  targetById,
  editorEmail,
  perms,
  onClose,
  onStep,
}: RunDrawerProps) {
  const runId = run.run_id;
  const qc = useQueryClient();
  const isOutline = run.status === "hitl_1";
  const target = resolveTarget(run, personaBySlug, targetById);
  const voice = voiceName(run, personaBySlug);

  // Slide-in on mount.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Fresh detail (the list payload is usually enough, but this keeps the open
  // run authoritative); fall back to the passed summary while it loads.
  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(runId),
    initialData: run,
  });
  const r = detail.data ?? run;

  const autosave = useCmsAutosave(r, editorEmail, {
    canEditMeta: perms.canEditMeta,
    canPatch: perms.canPatch,
  });

  const users = useWpUsers(runId);
  const categories = useWpCategories(runId);

  // Outlined-mode panels.
  const gap = useQuery({
    queryKey: ["run", runId, "gap-analysis"],
    enabled: isOutline && r.start_mode !== "create",
    queryFn: () => api.getGapAnalysis(runId).catch(() => null),
  });
  const outline = useQuery({
    queryKey: ["run", runId, "outline"],
    enabled: isOutline,
    queryFn: () => api.getOutline(runId).then((o) => o.payload).catch(() => null),
  });

  // Live post link (default mode, when pushed).
  const existing = useQuery({
    queryKey: ["run", runId, "existing-post"],
    enabled: !isOutline && r.wp_pushed_post_id != null,
    queryFn: () => api.getExistingPost(runId).catch(() => null),
  });

  // Keyboard: Esc closes, j/↓ next, k/↑ prev.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "Escape") {
        onClose();
      } else if (!typing && (e.key === "j" || e.key === "ArrowDown")) {
        e.preventDefault();
        onStep(1);
      } else if (!typing && (e.key === "k" || e.key === "ArrowUp")) {
        e.preventDefault();
        onStep(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onStep]);

  // ── Actions ────────────────────────────────────────────────────────────
  const afterAction = (msg: string) => {
    toast.success(msg);
    void qc.invalidateQueries({ queryKey: RUNS_LIST_KEY });
    void qc.invalidateQueries({ queryKey: ["run", runId] });
    onClose();
  };

  const approveBody = (): Hitl2Request => {
    const v = autosave.values;
    return {
      decision: "approve",
      editor_email: editorEmail,
      edited_html_body: autosave.body?.html_body ?? null,
      edited_seo_title: v.seoTitle || null,
      edited_meta_description: v.metaDesc || null,
      wp_publish_status: v.pubStatus || "draft",
      wp_author_id: v.authorId,
      wp_category_ids: v.categoryId != null ? [v.categoryId] : null,
      wp_slug: v.slug || null,
      wp_publish_at: v.pubStatus === "future" && v.pubDate ? `${v.pubDate}T00:00:00Z` : null,
      comments: [],
    };
  };

  const [confirmLabel, setConfirmLabel] = useState<string | null>(null);
  const dry = useMutation({
    mutationFn: () =>
      api.dryPublish(runId, {
        edited_seo_title: autosave.values.seoTitle || null,
        edited_meta_description: autosave.values.metaDesc || null,
        wp_publish_status: autosave.values.pubStatus || null,
        wp_author_id: autosave.values.authorId,
      }),
    onSuccess: (res) => setConfirmLabel(res.target_label),
    onError: (e: Error) => toast.error(`Dry-publish failed — ${e.message}`),
  });
  const publish = useMutation({
    mutationFn: () => api.resumeHitl2(runId, approveBody()),
    onSuccess: () => {
      setConfirmLabel(null);
      afterAction("Approved & published");
    },
    onError: (e: Error) => toast.error(`Publish failed — ${e.message}`),
  });
  const rejectDraft = useMutation({
    mutationFn: () =>
      api.resumeHitl2(runId, {
        decision: "reject",
        editor_email: editorEmail,
        wp_publish_status: "draft",
        comments: [],
      }),
    onSuccess: () => afterAction("Run rejected"),
    onError: (e: Error) => toast.error(e.message),
  });
  const approveOutline = useMutation({
    mutationFn: () => api.resumeHitl1(runId, { decision: "approve" }),
    onSuccess: () => afterAction("Outline approved"),
    onError: (e: Error) => toast.error(e.message),
  });
  const rejectOutline = useMutation({
    mutationFn: () => api.resumeHitl1(runId, { decision: "cancel" }),
    onSuccess: () => afterAction("Run cancelled"),
    onError: (e: Error) => toast.error(e.message),
  });
  const restart = useMutation({
    mutationFn: () => api.restartRun(runId),
    onSuccess: () => afterAction("Run restarted"),
    onError: (e: Error) => toast.error(e.message),
  });
  const republish = useMutation({
    mutationFn: () => api.republish(runId),
    onSuccess: () => afterAction("Republished with edits"),
    onError: (e: Error) => toast.error(e.message),
  });

  const busy =
    dry.isPending ||
    publish.isPending ||
    rejectDraft.isPending ||
    approveOutline.isPending ||
    rejectOutline.isPending ||
    restart.isPending ||
    republish.isPending;

  return (
    <>
      <aside
        aria-label={`Run detail: ${r.topic}`}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex h-[min(440px,58vh)] flex-col border-t-2 border-accent bg-paper shadow-[0_-10px_40px_rgba(29,26,22,0.14)] transition-transform duration-200 max-md:h-[92dvh]",
          entered ? "translate-y-0" : "translate-y-full",
        )}
      >
        {/* Header */}
        <div className="flex flex-none items-center gap-3 border-b border-rule/60 px-7 py-3 max-md:px-3.5">
          <button className={NAV_BTN} title="Previous run (k)" onClick={() => onStep(-1)} aria-label="Previous run">
            ↑
          </button>
          <button className={NAV_BTN} title="Next run (j)" onClick={() => onStep(1)} aria-label="Next run">
            ↓
          </button>
          <span className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold text-ink">
            {r.topic}
          </span>
          <StatusPill status={r.status} />
          <span className="font-mono text-[10.5px] text-ink-faint">{runId.slice(0, 8)}</span>
          <button className={NAV_BTN} title="Close (Esc)" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="mx-auto grid w-full max-w-[1400px] flex-1 grid-cols-[1fr_1.1fr_1.15fr] overflow-hidden max-[1080px]:grid-cols-[1.1fr_1.15fr] max-md:flex max-md:flex-col max-md:overflow-y-auto">
          {/* Brief — dropped in the 761–1080 band */}
          <div className="overflow-hidden max-[1080px]:hidden max-md:block max-md:overflow-visible">
            <BriefColumn run={r} voice={voice} />
          </div>

          {/* Middle: draft preview / gap analysis */}
          <div className="overflow-y-auto border-l border-rule/60 px-6 py-3.5 max-md:overflow-visible max-md:border-l-0 max-md:border-t">
            <div className="mb-2.5 font-display text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
              {isOutline ? "Gap analysis" : "Draft preview"}
            </div>
            {isOutline ? (
              <GapPanel gap={gap.data ?? null} createMode={r.start_mode === "create"} />
            ) : (
              <DraftPreview
                runId={runId}
                status={r.status}
                seoTitle={autosave.values.seoTitle}
                metaDesc={autosave.values.metaDesc}
                slug={decodeSlug(r)}
                targetName={target.name}
                liveLink={existing.data?.link ?? null}
              />
            )}
          </div>

          {/* Right: CMS form / outline + actions */}
          <div className="flex flex-col overflow-y-auto border-l border-rule/60 px-6 py-3.5 max-md:overflow-visible max-md:border-l-0 max-md:border-t">
            <div className="mb-2.5 font-display text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
              {isOutline ? (
                "Outline"
              ) : (
                <>
                  CMS destination{" "}
                  <span className="font-sans font-medium normal-case tracking-normal text-ink-faint">
                    · {target.name}
                  </span>
                </>
              )}
            </div>

            <div className="flex-1">
              {isOutline ? (
                <OutlinePanel outline={outline.data ?? null} />
              ) : (
                <CmsForm
                  autosave={autosave}
                  tag={target.tag}
                  users={users.data ?? []}
                  usersLoading={users.isLoading}
                  usersError={users.isError ? "error" : null}
                  onRetryUsers={() => void users.refetch()}
                  categories={categories.data ?? []}
                  categoriesLoading={categories.isLoading}
                  categoriesError={categories.isError ? "error" : null}
                  onRetryCategories={() => void categories.refetch()}
                  canEditMeta={perms.canEditMeta}
                  canPatch={perms.canPatch}
                />
              )}
            </div>

            {/* Actions */}
            <div className="sticky bottom-0 mt-3.5 flex flex-wrap items-center gap-2 bg-paper py-2.5">
              {isOutline ? (
                <>
                  {perms.canApproveOutline && (
                    <>
                      <Button variant="destructive" size="sm" disabled={busy} onClick={() => rejectOutline.mutate()}>
                        Reject
                      </Button>
                      <Button variant="primary" size="sm" disabled={busy} onClick={() => approveOutline.mutate()}>
                        Approve outline
                      </Button>
                    </>
                  )}
                </>
              ) : r.status === "hitl_2" ? (
                <>
                  {perms.canPublish && (
                    <>
                      <Button variant="destructive" size="sm" disabled={busy} onClick={() => rejectDraft.mutate()}>
                        Reject
                      </Button>
                      <Button variant="primary" size="sm" disabled={busy} onClick={() => dry.mutate()}>
                        {dry.isPending ? "Checking target…" : "Approve & publish"}
                      </Button>
                    </>
                  )}
                  <span className="ml-auto text-[11px] text-ink-faint">metadata autosaves · PATCH /runs/:id</span>
                </>
              ) : r.status === "failed" || r.status === "rejected" || r.status === "cancelled" ? (
                perms.canRestart && (
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => restart.mutate()}>
                    Restart run
                  </Button>
                )
              ) : r.status === "published" || r.status === "persisted" ? (
                perms.canRepublish && (
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => republish.mutate()}>
                    Republish with edits
                  </Button>
                )
              ) : (
                <span className="ml-auto text-[11px] text-ink-faint">metadata autosaves · PATCH /runs/:id</span>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Dry-publish target confirm (spec §6 — preserved before approve-publish) */}
      <Dialog open={confirmLabel != null} onOpenChange={(o) => !o && setConfirmLabel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish to {confirmLabel}?</DialogTitle>
            <DialogDescription>
              This approves the draft and pushes it to <strong>{confirmLabel}</strong> with publish status
              “{autosave.values.pubStatus || "draft (default)"}”. Confirm the target before publishing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmLabel(null)} disabled={publish.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => publish.mutate()} disabled={publish.isPending}>
              {publish.isPending ? "Publishing…" : "Confirm & publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
