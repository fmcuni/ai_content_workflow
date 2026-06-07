"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { CreateRunRequest, Mode, Persona } from "@/lib/types";
import { cn } from "@/lib/utils";

// Shared building blocks for the two assignment ledgers: the refresh ledger on
// `app/runs/new` (Front I) and the create ledger in `CreateLedger` (Front III).
// Both render the same grid of rows; they differ only by an Article-URL column
// and whether `Mode` is an editable select (refresh) or a static badge (create).

export const DEFAULT_PERSONA = "bowtie-editor";

export type RowStatus = "idle" | "submitting" | "done" | "error";

export interface LedgerRow {
  uid: string;
  article_url: string;
  topic: string;
  keywords: string;
  mode: Mode;
  persona: string;
  edit_note: string;
  acf_adv_id: number;
  acf_widget_id: number;
  status: RowStatus;
  result: { run_id?: string; error?: string } | null;
}

export type LedgerVariant = "refresh" | "create";

let _uid = 0;
const nextUid = (prefix: string) => `${prefix}${++_uid}-${Date.now().toString(36)}`;

export function blankRow(prefix: string, persona = DEFAULT_PERSONA): LedgerRow {
  return {
    uid: nextUid(prefix),
    article_url: "",
    topic: "",
    keywords: "",
    mode: "auto",
    persona,
    edit_note: "",
    acf_adv_id: 0,
    acf_widget_id: 0,
    status: "idle",
    result: null,
  };
}

/** Row-list state shared by both ledgers: add / remove / patch + expand toggle. */
export function useLedgerRows(prefix: string, initialCount = 3) {
  const [rows, setRows] = useState<LedgerRow[]>(() =>
    Array.from({ length: initialCount }, () => blankRow(prefix)),
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  function patchRow(uid: string, patch: Partial<LedgerRow>) {
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, blankRow(prefix, rs[rs.length - 1]?.persona ?? DEFAULT_PERSONA)]);
  }
  function removeRow(uid: string) {
    setRows((rs) => (rs.length === 1 ? [blankRow(prefix)] : rs.filter((r) => r.uid !== uid)));
    if (expanded === uid) setExpanded(null);
  }

  return {
    rows,
    setRows,
    expanded,
    setExpanded,
    newRow: (persona?: string) => blankRow(prefix, persona),
    patchRow,
    addRow,
    removeRow,
  };
}

interface SubmitResult {
  uid: string;
  run_id?: string;
  error?: string;
}

interface UseLedgerSubmitOptions {
  rows: LedgerRow[];
  patchRow: (uid: string, patch: Partial<LedgerRow>) => void;
  /** Which rows are eligible to file (e.g. require a URL on the refresh front). */
  isReady: (row: LedgerRow) => boolean;
  /** Per-front request shape: create vs refresh differ here. */
  buildRequest: (row: LedgerRow) => CreateRunRequest;
}

/**
 * Files every ready, not-yet-done row sequentially, marking each
 * submitting → done/error, and navigates to the run when exactly one filed.
 */
export function useLedgerSubmit({ rows, patchRow, isReady, buildRequest }: UseLedgerSubmitOptions) {
  const router = useRouter();
  return useMutation({
    mutationFn: async () => {
      const targets = rows.filter((r) => isReady(r) && r.status !== "done");
      const results: SubmitResult[] = [];
      for (const r of targets) {
        patchRow(r.uid, { status: "submitting", result: null });
        try {
          const res = await api.createRun(buildRequest(r));
          patchRow(r.uid, { status: "done", result: { run_id: res.run_id } });
          results.push({ uid: r.uid, run_id: res.run_id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          patchRow(r.uid, { status: "error", result: { error: msg } });
          results.push({ uid: r.uid, error: msg });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => r.run_id);
      if (ok.length === 1 && results.length === 1) {
        router.push(`/runs/${ok[0].run_id}`);
      }
    },
  });
}

const GRID_COLS: Record<LedgerVariant, string> = {
  refresh:
    "md:grid-cols-[40px_minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_108px_minmax(0,1.1fr)_88px_88px_36px_36px]",
  create:
    "md:grid-cols-[40px_minmax(0,2.2fr)_minmax(0,1.8fr)_108px_minmax(0,1.1fr)_88px_88px_36px_36px]",
};

const HEADERS: Record<LedgerVariant, readonly string[]> = {
  refresh: ["№", "Article URL", "Topic", "Focus keywords", "Mode", "Voice", "ADV", "Widget", "", ""],
  create: ["№", "Topic", "Focus keywords", "Mode", "Voice", "ADV", "Widget", "", ""],
};

const SELECT_CLASSES =
  "h-9 w-full bg-transparent text-[13px] text-ink border-0 border-b border-rule rounded-none px-0 py-1.5 outline-none focus-visible:border-b-2 focus-visible:border-accent appearance-none cursor-pointer";

export function LedgerHeader({ variant }: { variant: LedgerVariant }) {
  return (
    <div className={cn("hidden md:grid bg-paper-deep border-b border-rule", GRID_COLS[variant])}>
      {HEADERS[variant].map((t, i) => (
        <div
          key={i}
          className={cn(
            "px-3 py-2 kicker border-r border-rule last:border-r-0",
            i === 0 && "text-center",
          )}
        >
          {t}
        </div>
      ))}
    </div>
  );
}

interface LedgerFooterProps {
  rowCount: number;
  readyCount: number;
  filedCount: number;
  onAddRow: () => void;
}

export function LedgerFooter({ rowCount, readyCount, filedCount, onAddRow }: LedgerFooterProps) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2 bg-paper-deep/60 border-t border-rule">
      <p className="font-mono text-[11px] text-ink-faint">
        {rowCount} row{rowCount === 1 ? "" : "s"} · {readyCount} ready to file
        {filedCount > 0 && (
          <>
            {" "}
            · <span className="text-ok">{filedCount} filed</span>
          </>
        )}
      </p>
      <button
        type="button"
        onClick={onAddRow}
        className="font-mono text-[11px] text-ink-soft hover:text-ink underline underline-offset-2"
      >
        + new row
      </button>
    </div>
  );
}

/** The "— 30 —" sign-off shown once every filled row is filed. */
export function LedgerDoneBanner({ note }: { note: string }) {
  return (
    <div className="flex flex-col items-center gap-1 pt-6 pb-2">
      <p
        className="font-display text-[22px] tracking-[0.4em] text-ink-faint"
        style={{ fontStyle: "italic" }}
      >
        — 30 —
      </p>
      <p className="font-mono text-[10.5px] text-ink-faint">{note}</p>
    </div>
  );
}

interface LedgerRowViewProps {
  row: LedgerRow;
  index: number;
  variant: LedgerVariant;
  personas: Persona[];
  personasLoading: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<LedgerRow>) => void;
  onRemove: () => void;
}

export function LedgerRowView({
  row,
  index,
  variant,
  personas,
  personasLoading,
  isOpen,
  onToggle,
  onPatch,
  onRemove,
}: LedgerRowViewProps) {
  const status = row.status;
  const statusDot =
    status === "done"
      ? "bg-ok"
      : status === "submitting"
        ? "bg-warn animate-pulse"
        : status === "error"
          ? "bg-accent-deep"
          : "bg-rule";

  return (
    <div
      className={cn(
        "border-b border-rule last:border-b-0",
        status === "done" && "bg-ok/[0.04]",
        status === "error" && "bg-accent/[0.05]",
      )}
    >
      <div className={cn("grid grid-cols-1", GRID_COLS[variant])}>
        <div className="flex items-center justify-center md:border-r border-rule px-2 py-2 relative">
          <span
            className="font-display text-[20px] text-ink-faint tabular-nums leading-none"
            style={{ fontVariationSettings: '"opsz" 36' }}
          >
            {String(index + 1).padStart(2, "0")}
          </span>
          <span
            aria-hidden
            className={cn("absolute right-1 top-1 size-1.5 rounded-full", statusDot)}
            title={status}
          />
        </div>

        {variant === "refresh" && (
          <Cell label="Article URL">
            <Input
              value={row.article_url}
              onChange={(e) => onPatch({ article_url: e.target.value })}
              placeholder="https://www.bowtie.com.hk/blog/zh/…"
              className="font-mono text-[12px]"
            />
          </Cell>
        )}

        <Cell label="Topic">
          <Input
            value={row.topic}
            onChange={(e) => onPatch({ topic: e.target.value })}
            placeholder="Article topic"
          />
        </Cell>

        <Cell label="Focus keywords">
          <Input
            value={row.keywords}
            onChange={(e) => onPatch({ keywords: e.target.value })}
            placeholder="kw1, kw2, kw3"
          />
        </Cell>

        <Cell label="Mode">
          {variant === "refresh" ? (
            <select
              value={row.mode}
              onChange={(e) => onPatch({ mode: e.target.value as Mode })}
              className={SELECT_CLASSES}
            >
              <option value="auto">Auto</option>
              <option value="small_refresh">Small refresh</option>
              <option value="full_rewrite">Full rewrite</option>
            </select>
          ) : (
            <span
              className={cn(
                "inline-flex items-center h-9 px-2 font-mono text-[11px] tracking-[0.16em] uppercase",
                "text-accent-deep border-b border-rule",
              )}
              aria-label="mode: create"
            >
              Create
            </span>
          )}
        </Cell>

        <Cell label="Voice">
          <select
            value={row.persona}
            onChange={(e) => onPatch({ persona: e.target.value })}
            className={SELECT_CLASSES}
            disabled={personasLoading}
          >
            {personasLoading && <option>Loading voices…</option>}
            {!personasLoading && personas.length === 0 && (
              <option value={DEFAULT_PERSONA}>{DEFAULT_PERSONA}</option>
            )}
            {personas.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
            {!personasLoading &&
              personas.length > 0 &&
              !personas.some((p) => p.slug === row.persona) && (
                <option value={row.persona}>{row.persona} (unknown)</option>
              )}
          </select>
        </Cell>

        <Cell label="ADV">
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={row.acf_adv_id === 0 ? "" : row.acf_adv_id}
            onChange={(e) =>
              onPatch({ acf_adv_id: parseInt(e.target.value.replace(/\D/g, "") || "0", 10) })
            }
            placeholder="none"
            className="font-mono text-[12px] tabular-nums"
            aria-label="acf_adv_id"
          />
        </Cell>

        <Cell label="Widget">
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={row.acf_widget_id === 0 ? "" : row.acf_widget_id}
            onChange={(e) =>
              onPatch({ acf_widget_id: parseInt(e.target.value.replace(/\D/g, "") || "0", 10) })
            }
            placeholder="none"
            className="font-mono text-[12px] tabular-nums"
            aria-label="acf_widget_id"
          />
        </Cell>

        <div className="md:border-l border-rule flex items-center justify-center px-1 py-2">
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              "size-6 inline-flex items-center justify-center font-mono text-[14px] text-ink-soft hover:text-ink hover:bg-paper-deep transition-colors",
              isOpen && "bg-paper-deep text-ink",
            )}
            aria-label="More fields"
            title="Edit note"
          >
            {isOpen ? "−" : "+"}
          </button>
        </div>

        <div className="md:border-l border-rule flex items-center justify-center px-1 py-2">
          <button
            type="button"
            onClick={onRemove}
            className="size-6 inline-flex items-center justify-center font-mono text-[13px] text-ink-faint hover:text-accent-deep transition-colors"
            aria-label="Remove row"
            title="Strike row"
          >
            ×
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="grid grid-cols-1 md:grid-cols-[40px_1fr] border-t border-rule bg-paper-deep/40">
          <div className="hidden md:block md:border-r border-rule" />
          <div className="px-4 py-4">
            <label className="flex flex-col gap-1">
              <span className="kicker">Edit note</span>
              <Textarea
                value={row.edit_note}
                onChange={(e) => onPatch({ edit_note: e.target.value })}
                rows={2}
                placeholder="What the desk wants on this run."
                className="bg-paper"
              />
            </label>
          </div>
        </div>
      )}

      {row.result && (
        <div
          className={cn(
            "px-3 py-1.5 font-mono text-[11px] flex items-center justify-between gap-3 border-t border-rule",
            status === "done" && "bg-ok/[0.08] text-ok",
            status === "error" && "bg-accent/[0.08] text-accent-deep",
          )}
        >
          {status === "done" && row.result.run_id && (
            <>
              <span>FILED · run_id {row.result.run_id.slice(0, 8)}…</span>
              <Link
                href={`/runs/${row.result.run_id}`}
                className="underline underline-offset-2 hover:text-ink"
              >
                Open run →
              </Link>
            </>
          )}
          {status === "error" && row.result.error && <span>ERROR · {row.result.error}</span>}
        </div>
      )}
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="md:border-r border-rule px-3 py-2">
      <span className="md:hidden kicker mb-1 block">{label}</span>
      {children}
    </div>
  );
}
