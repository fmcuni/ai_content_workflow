"use client";

import Link from "next/link";

import { statusHasDraft } from "@/lib/run-status";

interface DraftPreviewProps {
  runId: string;
  status: string;
  /** Run topic — always present; the SERP headline falls back to it when SEO title is unset. */
  title: string;
  seoTitle: string;
  metaDesc: string;
  slug: string | null;
  targetName: string;
  liveLink: string | null;
}

function emptyReason(status: string): string {
  if (status === "hitl_1") return "outline awaiting your review.";
  if (status === "failed") return "run failed before drafting.";
  if (status === "rejected" || status === "cancelled") return "run ended before a draft was produced.";
  return "agents still working.";
}

/** Middle column for default mode (spec §4.5): a Google-SERP-style draft preview. */
export function DraftPreview({ runId, status, title, seoTitle, metaDesc, slug, targetName, liveLink }: DraftPreviewProps) {
  // A draft exists once metadata is set OR the run reached a drafted status — a
  // published run with no SEO meta still has a draft (bug: previously keyed only
  // on seoTitle/metaDesc, so such runs falsely showed "agents still working").
  const hasDraft = Boolean(seoTitle || metaDesc || (title && statusHasDraft(status)));
  const headline = seoTitle || title;
  const editorHref = status === "hitl_2" ? `/runs/${runId}/hitl2` : `/runs/${runId}`;

  return (
    <div>
      {hasDraft ? (
        <div className="rounded-lg border border-rule bg-paper-deep/30 p-3.5">
          <div className="mb-1 break-all text-[11px] text-ok">
            {targetName}
            {slug ? ` › blog › ${slug.replace(/^\//, "")}` : ""}
          </div>
          <div className="mb-2 font-display text-[15.5px] font-semibold leading-snug text-ink">
            {headline || "(untitled draft)"}
          </div>
          {metaDesc && <div className="text-[12.5px] leading-relaxed text-ink-soft">{metaDesc}</div>}
        </div>
      ) : (
        <div className="py-3.5 text-[12.5px] italic text-ink-faint">
          No draft rendered yet — {emptyReason(status)}
        </div>
      )}

      <div className="mt-3.5 flex gap-3.5">
        <Link href={editorHref} className="text-[12.5px] font-semibold text-accent hover:underline">
          Open full editor →
        </Link>
        {liveLink && (
          <a
            href={liveLink}
            target="_blank"
            rel="noreferrer"
            className="text-[12.5px] font-semibold text-accent hover:underline"
          >
            View live post ↗
          </a>
        )}
      </div>
    </div>
  );
}
