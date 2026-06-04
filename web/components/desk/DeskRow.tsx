"use client";

import Link from "next/link";

import { PaperStamp } from "@/components/PaperStamp";
import { RoleButton } from "@/components/RoleGate";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { BATCH_META, CATEGORY_META, type DeskItem, type GateAction } from "@/lib/desk-items";
import type { BatchStatus, RunStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function ledgerDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: "---", time: "--:--" };
  return {
    day: DAYS[d.getDay()],
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

function StatusStamp({ item }: { item: DeskItem }) {
  if (item.kind === "run") return <RunStatusBadge status={item.status as RunStatus} />;
  const meta = BATCH_META[item.status as BatchStatus];
  return <PaperStamp tone={meta.tone} pulse={meta.pulse}>{meta.label}</PaperStamp>;
}

interface DeskRowProps {
  item: DeskItem;
  accent?: boolean;
  /** Fire a specific inline gate action. The page routes one-click vs. dialog. */
  onAction?: (item: DeskItem, action: GateAction) => void;
  onDelete?: (item: DeskItem) => void;
  /** Run id currently mid-mutation, so the acting row can show a pending state. */
  pendingId?: string | null;
}

/**
 * One assignment on the desk: ledger date · category + title · status stamp and
 * the inline gate actions for that status. The title block links into the item;
 * the gate buttons act in place so the operator never has to open the run.
 */
export function DeskRow({ item, accent, onAction, onDelete, pendingId }: DeskRowProps) {
  const { day, time } = ledgerDate(item.createdAt);
  const cat = CATEGORY_META[item.category];
  const canDelete = item.deletable && Boolean(onDelete);
  const pending = pendingId === item.id;

  return (
    <li className="relative border-b border-rule group">
      <div
        className={cn(
          "grid grid-cols-[64px_1fr] md:grid-cols-[64px_1fr_auto] gap-4 md:gap-6 py-4 items-start",
          accent && "border-l-2 border-l-accent pl-4",
          canDelete && "pr-9",
        )}
      >
        <Link
          href={item.rowHref}
          aria-label={`Open ${item.title}`}
          className="contents"
        >
          <div className="pt-0.5">
            <p className="font-mono text-[11px] text-ink-faint tracking-wider group-hover:text-accent transition-colors">
              {day}
            </p>
            <p className="font-mono text-[13px] text-ink-soft tabular-nums">{time}</p>
          </div>
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex items-center">
                <span aria-hidden className="text-ink-soft mr-1">{cat.glyph}</span>
                {cat.label}
                {item.categoryNote ? <span className="text-ink-soft"> · {item.categoryNote}</span> : null}
              </span>
              {item.autoAccept ? (
                <span
                  className="border border-rule rounded-sm px-1 py-px text-[9px] tracking-[0.16em] text-ink-soft bg-paper-deep/50"
                  title="Auto-approves the HITL_1 outline gate"
                >
                  AUTO HITL_1
                </span>
              ) : null}
            </p>
            <p
              className="font-display text-[20px] leading-tight text-ink truncate mt-0.5 group-hover:text-accent transition-colors"
              style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
            >
              {item.title}
            </p>
            <p className="font-sans text-[12px] text-ink-faint truncate mt-1">{item.subtitle}</p>
            {item.meta && item.meta.length > 0 ? (
              <p className="font-mono text-[10.5px] text-ink-soft tracking-[0.02em] mt-1 truncate">
                {item.meta.join("  ·  ")}
              </p>
            ) : null}
            {item.keywords && item.keywords.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5 mt-1.5">
                {item.keywords.map((kw) => (
                  <li
                    key={kw}
                    className="font-mono text-[10px] tracking-[0.04em] text-ink-soft border border-rule rounded-sm px-1.5 py-0.5 bg-paper-deep/40"
                  >
                    {kw}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Link>

        <div className="col-start-2 md:col-start-3 flex flex-col items-start md:items-end gap-2">
          <StatusStamp item={item} />
          <DeskRowActions item={item} onAction={onAction} pending={pending} />
        </div>
      </div>

      {canDelete ? (
        <button
          type="button"
          aria-label={`Remove ${item.title}`}
          title={item.kind === "batch" ? "Remove topic batch" : "Remove run"}
          onClick={() => onDelete!(item)}
          className="absolute right-1 top-3 flex size-7 items-center justify-center rounded-full text-ink-faint opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-accent/10 hover:text-accent-deep transition-opacity"
        >
          <span aria-hidden className="text-[15px] leading-none">×</span>
        </button>
      ) : null}
    </li>
  );
}

/** The status-specific inline gate buttons rendered under the status stamp. */
function DeskRowActions({
  item,
  onAction,
  pending,
}: {
  item: DeskItem;
  onAction?: (item: DeskItem, action: GateAction) => void;
  pending: boolean;
}) {
  if (!onAction || item.gate === "open") {
    // Nothing actionable inline — but still offer the review/open affordance for
    // desk-lane items that only navigate (changes_requested, batch promote…).
    return item.action ? (
      <Link
        href={item.rowHref}
        className="font-sans text-[12px] font-medium text-accent hover:underline underline-offset-2 whitespace-nowrap"
      >
        {item.action} →
      </Link>
    ) : null;
  }

  const act = (a: GateAction) => () => onAction(item, a);

  if (item.gate === "approve_outline") {
    return (
      <div className="flex flex-wrap items-center gap-1.5 justify-start md:justify-end">
        <RoleButton
          need="hitl1_approve"
          deniedHint="Reviewer role required to approve the outline."
          size="xs"
          variant="primary"
          disabled={pending}
          onClick={act("approve_outline")}
        >
          {pending ? "Approving…" : "Approve outline"}
        </RoleButton>
        <Link
          href={item.rowHref}
          className="font-sans text-[12px] font-medium text-accent hover:underline underline-offset-2 whitespace-nowrap"
        >
          Review →
        </Link>
      </div>
    );
  }

  if (item.gate === "approve_publish") {
    return (
      <div className="flex flex-wrap items-center gap-1.5 justify-start md:justify-end">
        <RoleButton
          need="publish"
          deniedHint="Reviewer role required to approve & publish."
          size="xs"
          variant="primary"
          disabled={pending}
          onClick={act("approve_publish")}
        >
          {pending ? "Publishing…" : "Approve & publish"}
        </RoleButton>
        <RoleButton
          need="hitl2_decide"
          deniedHint="Reviewer role required to request changes."
          size="xs"
          variant="secondary"
          disabled={pending}
          onClick={act("request_changes")}
        >
          Request changes
        </RoleButton>
        <RoleButton
          need="hitl2_decide"
          deniedHint="Reviewer role required to reject."
          size="xs"
          variant="destructive"
          disabled={pending}
          onClick={act("reject")}
        >
          Reject
        </RoleButton>
        <Link
          href={item.rowHref}
          className="font-sans text-[12px] font-medium text-accent hover:underline underline-offset-2 whitespace-nowrap"
        >
          Review →
        </Link>
      </div>
    );
  }

  if (item.gate === "restart") {
    return (
      <div className="flex flex-wrap items-center gap-1.5 justify-start md:justify-end">
        <RoleButton
          need="create_run"
          deniedHint="Author role required to restart a run."
          size="xs"
          variant="secondary"
          disabled={pending}
          onClick={act("restart")}
        >
          {pending ? "Restarting…" : "Restart run"}
        </RoleButton>
        <Link
          href={item.rowHref}
          className="font-sans text-[12px] font-medium text-accent hover:underline underline-offset-2 whitespace-nowrap"
        >
          Inspect →
        </Link>
      </div>
    );
  }

  // promote (batch) and any other gate — navigate to the detail view.
  return item.action ? (
    <Link
      href={item.rowHref}
      className="font-sans text-[12px] font-medium text-accent hover:underline underline-offset-2 whitespace-nowrap"
    >
      {item.action} →
    </Link>
  ) : null;
}
