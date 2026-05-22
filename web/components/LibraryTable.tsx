"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { articlesApi } from "@/lib/api";
import type { Article, ArticleDetail } from "@/lib/types";
import { StalenessIndicator } from "@/components/StalenessIndicator";
import { ArticleDetailDrawer } from "@/components/ArticleDetailDrawer";
import { DismissDialog } from "@/components/DismissDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const PAGE_SIZE = 20;

interface LibraryTableProps {
  filters: {
    needs_refresh?: boolean;
    persona?: string;
    q?: string;
    sort?: "staleness" | "next_scan_due" | "last_persisted";
  };
}

function dotColor(action: string | undefined) {
  if (action === "refresh") return "bg-orange-500";
  if (action === "monitor") return "bg-amber-400";
  return "bg-neutral-300";
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
      <div className="py-12 text-center text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="py-12 text-center text-destructive text-sm">
        Failed to load articles.
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-neutral-50 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 w-6" />
              <th className="px-3 py-2">Topic / URL</th>
              <th className="px-3 py-2">Persona</th>
              <th className="px-3 py-2">Last persisted</th>
              <th className="px-3 py-2">Staleness</th>
              <th className="px-3 py-2">Top reason</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-10 text-center text-muted-foreground"
                >
                  No articles found.
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
                    className="border-b last:border-0 hover:bg-neutral-50 cursor-pointer transition-colors"
                    onClick={() => handleRowClick(a)}
                  >
                    {/* dot */}
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block h-2.5 w-2.5 rounded-full ${dotColor(action)}`}
                      />
                    </td>

                    {/* Topic / URL */}
                    <td className="px-3 py-2 max-w-xs">
                      <p className="font-medium line-clamp-1">
                        {a.topic ?? "—"}
                      </p>
                      <a
                        href={a.article_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-700 underline break-all line-clamp-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {a.article_url}
                      </a>
                    </td>

                    {/* Persona */}
                    <td className="px-3 py-2 text-muted-foreground">
                      {a.persona ?? "—"}
                    </td>

                    {/* Last persisted */}
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {a.last_persisted_at
                        ? new Date(a.last_persisted_at).toLocaleDateString()
                        : "—"}
                    </td>

                    {/* Staleness */}
                    <td className="px-3 py-2">
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
                    <td className="px-3 py-2 max-w-[200px] text-muted-foreground line-clamp-2 text-xs">
                      {topFinding ?? "—"}
                    </td>

                    {/* Actions */}
                    <td
                      className="px-3 py-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-2">
                        {/* Trigger button — only if eval is open */}
                        {ev?.outcome === "open" && (
                          <a
                            href={`/runs/new?article_id=${a.article_id}&evaluation_id=${ev.evaluation_id}`}
                            className="inline-flex h-7 items-center rounded-lg border border-border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted"
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
                                className="h-7 text-xs"
                              >
                                Dismiss ▾
                              </Button>
                            }
                          />
                          <DropdownMenuContent>
                            <DropdownMenuItem
                              onClick={() => handleDismissPreset(a, 7)}
                            >
                              7 days
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDismissPreset(a, 30)}
                            >
                              30 days
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDismissPreset(a, 90)}
                            >
                              90 days
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDismissCustom(a)}
                            >
                              Custom…
                            </DropdownMenuItem>
                            {a.dismissed_until && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() =>
                                    articlesApi
                                      .clearDismiss(a.article_id)
                                      .then(() => {
                                        void qc.invalidateQueries({
                                          queryKey: ["articles"],
                                        });
                                        toast.success("Dismiss cleared");
                                      })
                                      .catch((e: Error) =>
                                        toast.error(e.message)
                                      )
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
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {from}–{to} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={to >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
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
