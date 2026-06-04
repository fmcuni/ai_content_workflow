"use client";

import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { decodeSlug } from "@/lib/runs-grid/slug";
import { cn } from "@/lib/utils";

// Inline cell editors for the Ledger board, styled to match the demo's
// .editcell / .tin / .din / .numin (quiet until hover/focus; a rust accent while
// a save is in flight). Each editor commits a single field change upward; the
// parent wires it to the optimistic PATCH mutation. Pure presentation —
// concurrency + persistence live in use-run-patch / use-batch-patch.

export interface CellOption {
  value: string;
  label: string;
}

const SELECT_BASE =
  "font-sans text-[12.5px] text-ink bg-transparent border border-transparent rounded-sm " +
  "px-[5px] py-0.5 -mx-[5px] -my-0.5 cursor-pointer appearance-none max-w-[140px] " +
  "hover:border-rule hover:bg-paper focus:border-accent focus:bg-paper focus:outline-none";
const TEXT_BASE =
  "font-sans text-[12.5px] text-ink bg-transparent border border-transparent rounded-sm " +
  "px-[5px] py-0.5 -mx-[5px] -my-0.5 w-[150px] " +
  "hover:border-rule hover:bg-paper focus:border-accent focus:bg-paper focus:outline-none";
const DATE_BASE =
  "font-mono text-[11.5px] text-ink-soft bg-transparent border border-transparent rounded-sm " +
  "px-1 py-0.5 -mx-1 -my-0.5 " +
  "hover:border-rule hover:bg-paper focus:border-accent focus:bg-paper focus:outline-none";
const NUM_BASE =
  "font-mono text-[11.5px] w-[54px] text-ink-soft bg-transparent border border-transparent rounded-sm " +
  "px-1 py-0.5 -mx-1 -my-0.5 " +
  "hover:border-rule hover:bg-paper focus:border-accent focus:bg-paper focus:outline-none";

/** Single-select cell (author, publish status). Commits on change. */
export function SelectCell({
  value,
  options,
  onChange,
  pending,
  ariaLabel,
}: {
  value: string;
  options: readonly CellOption[];
  onChange: (value: string) => void;
  pending?: boolean;
  ariaLabel: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(SELECT_BASE, pending && "text-accent font-medium")}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Multi-select cell (WordPress categories) via a checkbox dropdown. */
export function MultiSelectCell({
  selected,
  options,
  onChange,
  pending,
  ariaLabel,
  emptyLabel = "—",
}: {
  selected: readonly number[];
  options: readonly CellOption[];
  onChange: (next: number[]) => void;
  pending?: boolean;
  ariaLabel: string;
  emptyLabel?: string;
}) {
  const selectedSet = new Set(selected);
  const labelById = new Map(options.map((o) => [o.value, o.label]));
  const summary =
    selected.length === 0
      ? emptyLabel
      : selected.map((id) => labelById.get(String(id)) ?? `#${id}`).join(", ");

  function toggle(idValue: string, checked: boolean) {
    const id = Number(idValue);
    const next = checked ? [...selected, id] : selected.filter((x) => x !== id);
    onChange([...new Set(next)]);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={ariaLabel}
        className={cn(
          "font-sans text-[12.5px] text-left text-ink bg-transparent border border-transparent rounded-sm",
          "px-[5px] py-0.5 -mx-[5px] -my-0.5 w-full truncate cursor-pointer",
          "hover:border-rule hover:bg-paper focus:border-accent focus:bg-paper focus:outline-none",
          pending && "text-accent font-medium",
        )}
      >
        {summary}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[280px] overflow-auto">
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={selectedSet.has(Number(o.value))}
            onCheckedChange={(c) => toggle(o.value, c === true)}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Slug text cell. Shows the decoded slug; commits the raw text on blur / Enter
 * (the server canonicalizes). Keyed on the stored value so an external update
 * (optimistic/refetch) resets the field.
 */
export function SlugCell({
  slug,
  onCommit,
  pending,
}: {
  slug: string | null | undefined;
  onCommit: (raw: string) => void;
  pending?: boolean;
}) {
  const decoded = decodeSlug(slug);
  const [draft, setDraft] = useState(decoded);

  function commit() {
    if (draft !== decoded) onCommit(draft);
  }

  return (
    <input
      key={slug ?? ""}
      aria-label="WordPress slug"
      defaultValue={decoded}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      placeholder="—"
      title={`Stored: ${slug || "—"}\nAccepts decoded (手足口病) or encoded (%E6…)`}
      className={cn(TEXT_BASE, pending && "text-accent")}
    />
  );
}

/** Post-date cell. Date-only picker; commits midnight UTC of the chosen day. */
export function DateCell({
  isoValue,
  onChange,
  pending,
}: {
  isoValue: string | null | undefined;
  onChange: (iso: string) => void;
  pending?: boolean;
}) {
  const day = isoValue ? isoValue.slice(0, 10) : "";
  return (
    <input
      type="date"
      aria-label="Post date"
      value={day}
      onChange={(e) => {
        // Date-only → midnight UTC. A cleared input is a no-op (PATCH can't null).
        if (e.target.value) onChange(`${e.target.value}T00:00:00.000Z`);
      }}
      className={cn(DATE_BASE, pending && "text-accent")}
    />
  );
}

/**
 * Numeric cell (ACF Adv / Widget id). Commits on blur / Enter. The tooltip sets
 * the expectation that the change only takes effect on the next re-run/republish.
 */
export function NumberCell({
  value,
  onCommit,
  pending,
}: {
  value: number | null | undefined;
  onCommit: (value: number) => void;
  pending?: boolean;
}) {
  const committed = value ?? "";
  const [draft, setDraft] = useState(String(committed));

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") return; // PATCH can't clear to null — leave unchanged
    const n = Number(trimmed);
    if (Number.isInteger(n) && n !== value) onCommit(n);
  }

  return (
    <input
      key={String(committed)}
      type="number"
      aria-label="ACF id"
      defaultValue={String(committed)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      title="Applies on the next re-run / republish, not the current draft"
      className={cn(NUM_BASE, pending && "text-accent")}
    />
  );
}
