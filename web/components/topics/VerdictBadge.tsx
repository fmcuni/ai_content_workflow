"use client";
import { useEffect, useRef, useState } from "react";
import type { ExistingVerdict, HotTopicVerdict } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ExternalLink } from "@/components/ExternalLink";

interface VerdictBadgeProps {
  kind: "existing" | "hot";
  verdict: ExistingVerdict | HotTopicVerdict | null;
  note: string | null;
  url?: string | null;
}

const EXISTING_LABEL: Record<ExistingVerdict, string> = {
  yes: "exists",
  no: "new",
  not_sure: "maybe",
};

const HOT_LABEL: Record<HotTopicVerdict, string> = {
  yes: "hot",
  no: "cold",
};

function variantClasses(kind: VerdictBadgeProps["kind"], verdict: string | null): string {
  if (verdict === null) {
    return "bg-paper-deep text-ink-faint border-rule";
  }
  if (kind === "existing") {
    if (verdict === "no")
      return "bg-ok/[0.08] text-ok border-ok/40";
    if (verdict === "yes")
      return "bg-accent/[0.10] text-accent-deep border-accent/40";
    return "bg-warn/[0.10] text-warn border-warn/40";
  }
  if (verdict === "yes")
    return "bg-accent/[0.14] text-accent-deep border-accent-deep/50";
  return "bg-paper-deep text-ink-faint border-rule";
}

export function VerdictBadge({ kind, verdict, note, url }: VerdictBadgeProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const hasDetail = !!(note || url);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const kicker = kind === "existing" ? "Existing?" : "Hot?";
  const label =
    verdict === null
      ? "—"
      : kind === "existing"
        ? EXISTING_LABEL[verdict as ExistingVerdict]
        : HOT_LABEL[verdict as HotTopicVerdict];

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
        title={hasDetail ? "Click for note" : undefined}
        className={cn(
          "inline-flex items-center gap-1.5 border px-1.5 py-[2px] font-mono text-[10px] uppercase tracking-[0.14em]",
          variantClasses(kind, verdict),
          hasDetail ? "cursor-pointer hover:brightness-95" : "cursor-default",
        )}
        aria-expanded={open}
      >
        <span className="text-ink-faint">{kicker}</span>
        <span className="font-semibold">{label}</span>
      </button>
      {open && hasDetail && (
        <div
          role="dialog"
          className={cn(
            "absolute z-30 top-full mt-1 left-0 min-w-[260px] max-w-[360px]",
            "bg-paper border border-rule shadow-lg p-3 space-y-2",
          )}
        >
          {note && <p className="text-[12px] leading-snug text-ink-soft">{note}</p>}
          {url && (
            <ExternalLink
              href={url}
              className="block font-mono text-[11px] text-accent-deep hover:underline break-all"
            >
              {url} ↗
            </ExternalLink>
          )}
        </div>
      )}
    </div>
  );
}
