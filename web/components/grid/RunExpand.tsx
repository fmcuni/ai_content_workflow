"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { PaperStamp } from "@/components/PaperStamp";
import { decodeSlug, isLivePublish, ledgerDate, publishLabel } from "@/lib/runs-grid/display";
import { auditSummary, costLine, extractH2s } from "@/lib/runs-grid/preview";
import { useRunExpand } from "@/lib/runs-grid/use-run-expand";
import { authorDisplay, categoryDisplay } from "@/lib/runs-grid/wp-names";
import { useWpCategoriesForPersona, useWpUsersForPersona } from "@/lib/use-wp-options";
import type { RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const EMPTY = "—";

/** Where "Open full draft →" goes: the HITL_2 editor when awaiting that gate. */
function fullDraftHref(run: RunSummary): string {
  return run.status === "hitl_2" ? `/runs/${run.run_id}/hitl2` : `/runs/${run.run_id}`;
}

interface RunExpandProps {
  run: RunSummary;
  /** Full board column count — the insert row spans all columns. */
  colSpan: number;
}

const KV_DT = "font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint";
const KV_DD = "m-0 text-ink-soft";

/**
 * The run-expand insert: a full-width paper insert with a two-panel layout —
 * left, a draft preview (SEO title, meta, H2 chips, excerpt, open-full link);
 * right, the destination & checks (target, source, slug, author, category,
 * publish, audit verdict, cost, last touch, error). Render/audit/cost load
 * lazily on expand; a 404 means "nothing drafted yet" (a graceful empty state),
 * not an error.
 */
export function RunExpand({ run, colSpan }: RunExpandProps) {
  const { render, audit, cost } = useRunExpand(run.run_id, true);

  return (
    <tr>
      <td colSpan={colSpan} className="p-0 bg-paper-deep border-b-2 border-ink">
        <div className="grid grid-cols-[1.5fr_1fr] gap-[30px] px-5 pt-3.5 pb-[18px] max-lg:grid-cols-1 max-lg:gap-4">
          <DraftPanel run={run} render={render} />
          <DestinationPanel run={run} audit={audit} cost={cost} />
        </div>
      </td>
    </tr>
  );
}

function PanelHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint mb-2.5">
      {children}
    </h4>
  );
}

function DraftPanel({
  run,
  render,
}: {
  run: RunSummary;
  render: ReturnType<typeof useRunExpand>["render"];
}) {
  return (
    <div>
      <PanelHeading>Draft preview</PanelHeading>
      {render.isLoading ? (
        <p className="text-ink-faint text-[12.5px]">Loading draft…</p>
      ) : render.notFound ? (
        <p className="font-display italic text-ink-faint text-[15px]">No draft generated yet.</p>
      ) : render.isError ? (
        <p className="text-accent-deep text-[12.5px]">Couldn’t load the draft preview.</p>
      ) : render.data ? (
        <DraftBody run={run} render={render.data} />
      ) : null}
    </div>
  );
}

function DraftBody({ run, render }: { run: RunSummary; render: NonNullable<ReturnType<typeof useRunExpand>["render"]["data"]> }) {
  const heads = extractH2s(render.html_body);
  return (
    <>
      <div className="font-display text-[18px] leading-tight text-ink">
        {render.seo_title || run.topic}
      </div>
      {render.meta_description ? (
        <div className="text-[12.5px] text-ink-soft mt-1 leading-[1.45]">{render.meta_description}</div>
      ) : null}
      {heads.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 my-2.5">
          {heads.map((h, i) => (
            <li
              key={`${i}:${h}`}
              className="font-mono text-[9.5px] tracking-[0.04em] border border-rule rounded-sm px-1.5 py-px text-ink-soft bg-paper/60"
            >
              H2 · {h}
            </li>
          ))}
        </ul>
      ) : null}
      {render.excerpt_suggestion ? (
        <p className="font-display text-[13.5px] leading-[1.65] text-ink-soft m-0">
          {render.excerpt_suggestion}
        </p>
      ) : null}
      <Link
        href={fullDraftHref(run)}
        className="text-[11.5px] font-medium inline-block mt-2.5 text-accent hover:underline underline-offset-2"
      >
        Open full draft →
      </Link>
    </>
  );
}

function DestinationPanel({
  run,
  audit,
  cost,
}: {
  run: RunSummary;
  audit: ReturnType<typeof useRunExpand>["audit"];
  cost: ReturnType<typeof useRunExpand>["cost"];
}) {
  // Resolve author/category names against this run's own voice (CMS instance).
  const users = useWpUsersForPersona(run.persona || undefined);
  const cats = useWpCategoriesForPersona(run.persona || undefined);
  const live = isLivePublish(run.wp_publish_status);
  const isRewrite = run.start_mode !== "create" && Boolean(run.article_url);
  const publish = publishLabel(run.wp_publish_status) + (run.wp_publish_at ? ` · ${ledgerDate(run.wp_publish_at)}` : "");

  return (
    <div>
      <PanelHeading>Destination &amp; checks</PanelHeading>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-[12.5px] items-baseline">
        <dt className={KV_DT}>Target</dt>
        <dd className={KV_DD}>
          production{live ? <> · <b className="text-accent-deep">live</b></> : null}
        </dd>

        {isRewrite ? (
          <>
            <dt className={KV_DT}>Source</dt>
            <dd className={cn(KV_DD, "font-mono text-[11.5px] truncate")}>
              <a
                href={run.article_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-soft hover:text-accent"
              >
                {run.article_url} ↗
              </a>
            </dd>
          </>
        ) : null}

        <dt className={KV_DT}>Slug</dt>
        <dd className={cn(KV_DD, "font-mono text-[11.5px]")}>{decodeSlug(run.wp_slug) || EMPTY}</dd>

        <dt className={KV_DT}>Author</dt>
        <dd className={KV_DD}>{authorDisplay(users.data, run.wp_author_id)}</dd>

        <dt className={KV_DT}>Category</dt>
        <dd className={KV_DD}>{categoryDisplay(cats.data, run.wp_category_ids)}</dd>

        <dt className={KV_DT}>Publish</dt>
        <dd className={KV_DD}>{publish}</dd>

        <dt className={KV_DT}>Audit</dt>
        <dd className={KV_DD}><AuditValue audit={audit} /></dd>

        <dt className={KV_DT}>Cost</dt>
        <dd className={cn(KV_DD, "font-mono text-[11.5px]")}>
          {cost.isLoading ? "…" : cost.isError ? "—" : costLine(cost.data, run.iteration_count)}
        </dd>

        <dt className={KV_DT}>Last touch</dt>
        <dd className={KV_DD}>{ledgerDate(run.created_at)}</dd>

        {run.error?.message ? (
          <>
            <dt className={KV_DT}>Error</dt>
            <dd className={cn(KV_DD, "text-accent-deep")}>{run.error.message}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function AuditValue({ audit }: { audit: ReturnType<typeof useRunExpand>["audit"] }) {
  if (audit.isLoading) return <>…</>;
  if (audit.notFound) return <span className="text-ink-faint">Not run yet</span>;
  if (audit.isError) return <span className="text-accent-deep">—</span>;
  const summary = auditSummary(audit.data);
  return (
    <span className="inline-flex items-center gap-2">
      <PaperStamp tone={summary.pass ? "ok" : "danger"}>{summary.pass ? "PASS" : "FAIL"}</PaperStamp>
      <span className="font-mono text-[11px] text-ink-faint">
        {summary.high}H {summary.medium}M {summary.low}L
      </span>
    </span>
  );
}
