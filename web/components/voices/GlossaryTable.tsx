"use client";

import { useMemo, useState } from "react";

import type { GlossaryEntry, GlossaryStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface GlossaryTableProps {
  entries: GlossaryEntry[];
  onChange: (next: GlossaryEntry[]) => void;
  readOnly?: boolean;
}

const STATUS_OPTIONS: { value: GlossaryStatus; label: string; hint: string }[] = [
  { value: "preferred", label: "保留 · Prefer", hint: "Use this form." },
  { value: "avoid", label: "避用 · Avoid", hint: "Swap to the preferred form." },
  { value: "forbidden", label: "禁用 · Forbidden", hint: "Never use." },
  { value: "do_not_translate", label: "保留原文 · DNT", hint: "Do not translate or localize." },
];

const STATUS_BADGE: Record<GlossaryStatus, string> = {
  preferred: "bg-ink/5 text-ink",
  avoid: "bg-accent/10 text-accent-deep",
  forbidden: "bg-accent-deep/15 text-accent-deep",
  do_not_translate: "bg-ink/10 text-ink-soft",
};

export function GlossaryTable({ entries, onChange, readOnly }: GlossaryTableProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<GlossaryStatus | "all">("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => {
        if (statusFilter !== "all" && e.status !== statusFilter) return false;
        if (!q) return true;
        return (
          e.term.toLowerCase().includes(q)
          || e.preferred.toLowerCase().includes(q)
          || e.variants.some((v) => v.toLowerCase().includes(q))
          || (e.notes ?? "").toLowerCase().includes(q)
        );
      });
  }, [entries, query, statusFilter]);

  const update = (i: number, patch: Partial<GlossaryEntry>) => {
    const next = [...entries];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };

  const remove = (i: number) => {
    onChange(entries.filter((_, j) => j !== i));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search term, preferred, variant, notes…"
          className="flex-1 min-w-[220px] border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as GlossaryStatus | "all")}
          className="border border-rule bg-paper px-2 py-1 text-[12px] font-mono tracking-wider uppercase"
        >
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">
          {filtered.length}/{entries.length} terms
        </p>
      </div>

      <div className="border border-rule">
        <div className="grid grid-cols-[120px_1.2fr_1.2fr_1.4fr_1.4fr_28px] gap-2 border-b border-rule bg-paper-deep/40 px-3 py-2 font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">
          <span>Status</span>
          <span>Term</span>
          <span>Preferred</span>
          <span>Variants (avoid)</span>
          <span>Notes</span>
          <span aria-label="actions" />
        </div>
        {filtered.length === 0 && (
          <p className="px-3 py-6 text-center font-mono text-[11px] tracking-wider uppercase text-ink-faint">
            {entries.length === 0 ? "Glossary is empty." : "No matches."}
          </p>
        )}
        {filtered.map(({ e, i }) => (
          <div
            key={i}
            className="grid grid-cols-[120px_1.2fr_1.2fr_1.4fr_1.4fr_28px] gap-2 items-start border-b border-rule px-3 py-2"
          >
            <select
              value={e.status}
              disabled={readOnly}
              onChange={(ev) => update(i, { status: ev.target.value as GlossaryStatus })}
              className={cn(
                "border border-rule px-1 py-1 text-[11px] font-mono uppercase tracking-wider",
                STATUS_BADGE[e.status],
              )}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <input
              value={e.term}
              readOnly={readOnly}
              onChange={(ev) => update(i, { term: ev.target.value })}
              className="border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
              placeholder="e.g. 自願醫保"
            />
            <input
              value={e.preferred}
              readOnly={readOnly}
              onChange={(ev) => update(i, { preferred: ev.target.value })}
              className="border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
              placeholder={e.status === "forbidden" ? "—" : "Canonical form"}
            />
            <input
              value={e.variants.join(" | ")}
              readOnly={readOnly}
              onChange={(ev) => update(i, {
                variants: ev.target.value.split("|").map((s) => s.trim()).filter(Boolean),
              })}
              className="border-b border-rule bg-transparent py-1 text-[13px] font-mono focus:outline-none focus:border-ink"
              placeholder="variant1 | variant2"
            />
            <input
              value={e.notes ?? ""}
              readOnly={readOnly}
              onChange={(ev) => update(i, { notes: ev.target.value || null })}
              className="border-b border-rule bg-transparent py-1 text-[13px] focus:outline-none focus:border-ink"
              placeholder="Why / where / source"
            />
            {!readOnly && (
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-ink-faint hover:text-accent-deep text-[14px]"
                aria-label="remove"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function emptyEntry(): GlossaryEntry {
  return { term: "", preferred: "", variants: [], status: "preferred", notes: null };
}

export function parseCsv(text: string): GlossaryEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => {
      const cells = line.split(",").map((c) => c.trim());
      const [term = "", preferred = "", variantsRaw = "", statusRaw = "preferred", notes = ""] = cells;
      const status: GlossaryStatus = (
        ["preferred", "avoid", "forbidden", "do_not_translate"].includes(statusRaw)
          ? statusRaw
          : "preferred"
      ) as GlossaryStatus;
      return {
        term,
        preferred,
        variants: variantsRaw.split("|").map((v) => v.trim()).filter(Boolean),
        status,
        notes: notes || null,
      };
    })
    .filter((e) => e.term);
}
