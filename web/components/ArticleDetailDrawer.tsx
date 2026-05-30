"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { RefreshFindingsPanel } from "@/components/RefreshFindingsPanel";
import { ExternalLink } from "@/components/ExternalLink";
import type { ArticleDetail } from "@/lib/types";

interface ArticleDetailDrawerProps {
  article: ArticleDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ArticleDetailDrawer({
  article,
  open,
  onOpenChange,
}: ArticleDetailDrawerProps) {
  if (!article) return null;

  const ev = article.latest_evaluation;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base leading-snug line-clamp-2">
            {article.topic ?? article.article_url}
          </SheetTitle>
          <SheetDescription>
            <ExternalLink
              href={article.article_url}
              className="text-xs text-blue-700 underline break-all"
            >
              {article.article_url}
            </ExternalLink>
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-4 space-y-6">
          {/* Meta */}
          <section className="grid grid-cols-2 gap-2 text-sm">
            {article.persona && (
              <>
                <span className="text-muted-foreground">Persona</span>
                <span>{article.persona}</span>
              </>
            )}
            {article.topic_category && (
              <>
                <span className="text-muted-foreground">Category</span>
                <span>{article.topic_category}</span>
              </>
            )}
            <span className="text-muted-foreground">Open runs</span>
            <span>{article.open_runs_count}</span>
            {article.dismissed_until && (
              <>
                <span className="text-muted-foreground">Dismissed until</span>
                <span>{new Date(article.dismissed_until).toLocaleDateString()}</span>
              </>
            )}
          </section>

          {/* Latest evaluation */}
          {ev ? (
            <section>
              <h3 className="font-medium mb-3">
                Latest evaluation{" "}
                <span className="text-xs text-muted-foreground font-normal">
                  {new Date(ev.evaluated_at).toLocaleDateString()}
                </span>
              </h3>
              <RefreshFindingsPanel ev={ev} />

              {/* Trigger update link */}
              <div className="mt-4">
                <a
                  href={`/runs/new?article_id=${article.article_id}&evaluation_id=${ev.evaluation_id}`}
                  className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2 hover:opacity-80"
                >
                  Trigger update run &rarr;
                </a>
              </div>
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">No evaluation yet.</p>
          )}

          {/* Recent run IDs */}
          {article.recent_run_ids.length > 0 && (
            <section>
              <h3 className="font-medium mb-2">Recent runs</h3>
              <ul className="space-y-1">
                {article.recent_run_ids.map((id) => (
                  <li key={id}>
                    <a
                      href={`/runs/${id}`}
                      className="text-xs text-blue-700 underline font-mono"
                    >
                      {id}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Evaluation history */}
          {article.recent_evaluations.length > 1 && (
            <section>
              <h3 className="font-medium mb-2">Evaluation history</h3>
              <ul className="space-y-2">
                {article.recent_evaluations.map((e) => (
                  <li
                    key={e.evaluation_id}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span className="text-muted-foreground">
                      {new Date(e.evaluated_at).toLocaleDateString()}
                    </span>
                    <Badge
                      variant={
                        e.recommended_action === "refresh"
                          ? "destructive"
                          : e.recommended_action === "monitor"
                          ? "secondary"
                          : "outline"
                      }
                    >
                      {e.recommended_action}
                    </Badge>
                    <span className="font-mono text-muted-foreground">
                      {Number(e.staleness_score).toFixed(1)}
                    </span>
                    <Badge variant="outline">{e.outcome}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
