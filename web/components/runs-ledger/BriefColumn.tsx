"use client";

import { useState } from "react";
import Link from "next/link";

import type { RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

import { fmtDateTime } from "./fmt";

const KEYWORD_CAP = 6;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pt-px text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </>
  );
}

/** Drawer's left "Brief" column (spec §4.5) — shared by both drawer modes. */
export function BriefColumn({ run, voice }: { run: RunSummary; voice: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const keywords = run.keywords ?? [];
  const shown = keywords.slice(0, KEYWORD_CAP);
  const extra = keywords.length - shown.length;
  const rev = run.hitl_2_iteration ?? 0;

  return (
    <div className="overflow-y-auto px-6 py-3.5">
      <div className="mb-2.5 font-display text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
        Brief
      </div>
      <dl className="grid grid-cols-[86px_1fr] gap-x-2.5 gap-y-1 text-[12.5px]">
        {voice && <Row label="Voice">{voice}</Row>}
        <Row label="Kind">{run.start_mode === "create" ? "New article" : "Rewrite"}</Row>
        {run.start_mode !== "create" && run.article_url && (
          <Row label="Source">
            <a
              href={run.article_url}
              target="_blank"
              rel="noreferrer"
              className="break-all text-info hover:underline"
            >
              {run.article_url}
            </a>
          </Row>
        )}
        {run.target_audience && <Row label="Audience">{run.target_audience}</Row>}
        {shown.length > 0 && (
          <Row label="Keywords">
            <span className="flex flex-wrap gap-1">
              {shown.map((k) => (
                <span key={k} className="rounded bg-paper-deep px-1.5 py-px text-[11px] text-ink-soft">
                  {k}
                </span>
              ))}
              {extra > 0 && <span className="px-1 text-[11px] text-ink-faint">+{extra}</span>}
            </span>
          </Row>
        )}
        <Row label="Created">{fmtDateTime(run.created_at)}</Row>
        {rev > 0 && <Row label="Revisions">{rev}</Row>}
        <dt className="pt-px text-ink-faint" />
        <dd>
          <Link href={`/runs/${run.run_id}/hitl2`} className="text-info hover:underline">
            Version history →
          </Link>
        </dd>
      </dl>

      {run.edit_note && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2.5 block w-full rounded-r-md border-l-[3px] border-warn bg-warn/10 px-2.5 py-2 text-left text-[12px] leading-relaxed text-[#7a5410]"
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-warn">
            Operator brief
          </div>
          <div className={cn("whitespace-pre-line", !expanded && "line-clamp-5")}>{run.edit_note}</div>
          <span className="mt-1 block text-[11px] font-semibold">
            {expanded ? "Show less" : "Show more"}
          </span>
        </button>
      )}
    </div>
  );
}
