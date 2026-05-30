"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { articlesApi } from "@/lib/api";
import type { Article, ArticleDetail } from "@/lib/types";
import { StalenessIndicator } from "@/components/StalenessIndicator";
import { ArticleDetailDrawer } from "@/components/ArticleDetailDrawer";
import { ExternalLink } from "@/components/ExternalLink";
import { DismissDialog } from "@/components/DismissDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

interface LibraryTableProps {
  filters: {
    needs_refresh?: boolean;
    persona?: string;
    q?: string;
    sort?: "staleness" | "next_scan_due" | "last_persisted";
  };
}

function dotColorStamp(action: string | undefined) {
  if (action === "refresh") return "text-accent";
  if (action === "monitor") return "text-warn";
  return "text-ink-faint";
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function LibraryTable({ filters }: LibraryTableProps) {
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);

  // Detail drawer
  const [drawerArticleId, setDrawerArticleId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["article-detail", drawerArticleId],
    queryFn: () => articlesApi.detail(drawerArticleId!),
    enabled: !!drawerArticleId,
  });

  // Dismiss dialog state
  const [dismissTarget, setDismissTarget] = useState<Article | null>(null);
  const [dismissDialogOpen, setDismissDialogOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["articles", filters, offset],
    queryFn: () =>
      articlesApi.list({ ...filters, limit: PAGE_SIZE, offset }),
    refetchInterval: filters.needs_refresh ? 3000 : false,
  });

  const dismissMutation = useMutation({
    mutationFn: ({
      articleId,
      until,
      reason,
    }: {
      articleId: string;
      until: string;
      reason?: string;
    }) =>
      articlesApi.dismiss(articleId, until, "editor@bowtie.local", reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["articles"] });
      setDismissDialogOpen(false);
      setDismissTarget(null);
      toast.success("Article dismissed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clearDismissMutation = useMutation({
    mutationFn: (articleId: string) => articlesApi.clearDismiss(articleId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["articles"] });
      toast.success("Dismiss cleared");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Any in-flight dismiss/clear disables the whole dropdown so reopening the
  // menu can't re-fire a second mutation before the first settles.
  const dismissBusy = dismissMutation.isPending || clearDismissMutation.isPending;

  function handleRowClick(a: Article) {
    setDrawerArticleId(a.article_id);
    setDrawerOpen(true);
  }

  function handleDismissPreset(a: Article, days: number) {
    dismissMutation.mutate({
      articleId: a.article_id,
      until: addDays(days),
    });
  }

  function handleDismissCustom(a: Article) {
    setDismissTarget(a);
    setDismissDialogOpen(true);
  }

  function handleDismissConfirm(until: Date, reason: string) {
    if (!dismissTarget) return;
    dismissMutation.mutate({
      articleId: dismissTarget.article_id,
      until: until.toISOString().slice(0, 10),
      reason,
    });
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  const drawerArticle: ArticleDetail | null =
    detailQuery.data ?? null;

  if (isLoading) {
    return (
      <div className="py-12 text-center text-ink-faint text-[13px]">
        Loading…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="py-12 text-center text-accent-deep text-[13px]">
        Failed to load articles.
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto border-t border-b border-rule">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-rule text-left font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              <th className="px-3 py-3 w-6" />
              <th className="px-3 py-3">Topic / URL</th>
              <th className="px-3 py-3">Persona</th>
              <th className="px-3 py-3">Last persisted</th>
              <th className="px-3 py-3">Staleness</th>
              <th className="px-3 py-3">Top reason</th>
              <th className="px-3 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-12 text-center font-display italic text-ink-faint text-[16px]"
                >
                  Nothing to file in the archive.
                </td>
              </tr>
            ) : (
              items.map((a) => {
                const ev = a.latest_evaluation;
                const action = ev?.recommended_action;
                const topFinding =
                  ev?.deterministic_findings.findings[0]?.message ?? null;

                return (
                  <tr
                    key={a.article_id}
                    className="border-b border-rule last:border-b-0 cursor-pointer transition-colors hover:bg-paper-deep/60 group"
                    onClick={() => handleRowClick(a)}
                  >
                    {/* dot */}
                    <td className="px-3 py-3">
                      <span aria-hidden className={cn("inline-block leading-none text-[14px]", dotColorStamp(action))}>▪</span>
                    </td>

                    {/* Topic / URL */}
                    <td className="px-3 py-3 max-w-xs">
                      <p className="font-display text-[15px] text-ink line-clamp-1" style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}>
                        {a.topic ?? "—"}
                      </p>
                      <ExternalLink
                        href={a.article_url}
                        className="font-mono text-[11px] text-ink-faint underline-offset-2 hover:underline break-all line-clamp-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {a.article_url}
                      </ExternalLink>
                    </td>

                    {/* Persona */}
                    <td className="px-3 py-3 text-ink-soft font-mono text-[12px]">
                      {a.persona ?? "—"}
                    </td>

                    {/* Last persisted */}
                    <td className="px-3 py-3 whitespace-nowrap text-ink-soft font-mono text-[12px] tabular-nums">
                      {a.last_persisted_at
                        ? new Date(a.last_persisted_at).toLocaleDateString()
                        : "—"}
                    </td>

                    {/* Staleness */}
                    <td className="px-3 py-3">
                      {ev ? (
                        <StalenessIndicator
                          score={ev.staleness_score}
                          recommendedAction={ev.recommended_action}
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>

                    {/* Top reason */}
                    <td className="px-3 py-3 max-w-[200px] text-ink-soft line-clamp-2 text-[12px]">
                      {topFinding ?? "—"}
                    </td>

                    {/* Actions */}
                    <td
                      className="px-3 py-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-2">
                        {/* Trigger button — only if eval is open */}
                        {ev?.outcome === "open" && (
                          <a
                            href={`/runs/new?article_id=${a.article_id}&evaluation_id=${ev.evaluation_id}`}
                            className="inline-flex h-7 items-center border border-ink bg-transparent text-ink px-2.5 text-[11px] font-medium transition-colors hover:bg-ink hover:text-paper rounded-[2px]"
                          >
                            Trigger
                          </a>
                        )}

                        {/* Dismiss dropdown */}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-[11px]"
                              >
                                Dismiss ▾
                              </Button>
                            }
                          />
                          <DropdownMenuContent>
                            <DropdownMenuItem
                              disabled={dismissBusy}
                              onClick={() => handleDismissPreset(a, 7)}
                            >
                              7 days
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={dismissBusy}
                              onClick={() => handleDismissPreset(a, 30)}
                            >
                              30 days
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={dismissBusy}
                              onClick={() => handleDismissPreset(a, 90)}
                            >
                              90 days
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={dismissBusy}
                              onClick={() => handleDismissCustom(a)}
                            >
                              Custom…
                            </DropdownMenuItem>
                            {a.dismissed_until && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  disabled={dismissBusy}
                                  onClick={() =>
                                    clearDismissMutation.mutate(a.article_id)
                                  }
                                >
                                  Clear
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between font-mono text-[12px] text-ink-soft tabular-nums">
          <span>{String(from).padStart(2, "0")} — {String(to).padStart(2, "0")} OF {String(total).padStart(2, "0")}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>← Prev</Button>
            <Button size="sm" variant="secondary" disabled={to >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next →</Button>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      <ArticleDetailDrawer
        article={drawerArticle}
        open={drawerOpen}
        onOpenChange={(open) => {
          setDrawerOpen(open);
          if (!open) setDrawerArticleId(null);
        }}
      />

      {/* Dismiss custom dialog */}
      <DismissDialog
        open={dismissDialogOpen}
        onOpenChange={setDismissDialogOpen}
        onConfirm={handleDismissConfirm}
        loading={dismissMutation.isPending}
      />
    </>
  );
}
