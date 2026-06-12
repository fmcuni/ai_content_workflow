"use client";

import { cn } from "@/lib/utils";
import {
  type LedgerTab,
  type SortOrder,
  type VoiceOption,
  TAB_LABEL,
  TAB_ORDER,
} from "./useLedgerData";

interface ToolbarProps {
  tab: LedgerTab;
  onTab: (tab: LedgerTab) => void;
  counts: Record<LedgerTab, number>;
  search: string;
  onSearch: (q: string) => void;
  voice: string;
  onVoice: (slug: string) => void;
  voices: VoiceOption[];
  sort: SortOrder;
  onSort: (s: SortOrder) => void;
}

const SELECT_CLASSES =
  "appearance-none rounded-md border border-rule bg-paper px-2.5 py-1.5 pr-7 text-[12.5px] text-ink " +
  "focus:border-accent focus:outline-2 focus:outline-accent/25";

/**
 * Sticky toolbar (spec §4.3): status tabs with client-derived counts, search,
 * voice filter and sort. Matches the demo's segmented control + pill selects.
 */
export function Toolbar({
  tab,
  onTab,
  counts,
  search,
  onSearch,
  voice,
  onVoice,
  voices,
  sort,
  onSort,
}: ToolbarProps) {
  return (
    <div className="sticky top-0 z-30 mx-auto flex max-w-[1400px] flex-wrap items-center gap-2.5 bg-paper px-7 pb-3 pt-2 max-md:static max-md:px-3.5">
      <div
        role="tablist"
        aria-label="Filter runs by status"
        className="flex gap-0.5 rounded-lg bg-paper-deep p-0.5 max-md:max-w-full max-md:overflow-x-auto"
      >
        {TAB_ORDER.map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={active}
              onClick={() => onTab(t)}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 font-medium text-ink-soft",
                active && "bg-paper font-semibold text-ink shadow-sm",
              )}
            >
              {TAB_LABEL[t]}
              <span
                className={cn(
                  "text-[11px] tabular-nums text-ink-faint",
                  active && "font-bold text-accent",
                )}
              >
                {counts[t]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grow" />

      <div className="relative max-md:order-first max-md:w-full">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          strokeWidth={2}
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-2 size-3.5 stroke-ink-faint"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search topic, slug, keyword…"
          aria-label="Search runs"
          className="w-[230px] rounded-md border border-rule bg-paper py-1.5 pl-7 pr-2.5 text-[12.5px] focus:border-accent focus:outline-2 focus:outline-accent/25 max-md:w-full"
        />
      </div>

      <select
        value={voice}
        onChange={(e) => onVoice(e.target.value)}
        aria-label="Filter by voice"
        className={SELECT_CLASSES}
      >
        <option value="">Voice — all</option>
        {voices.map((v) => (
          <option key={v.slug} value={v.slug}>
            {v.name}
          </option>
        ))}
      </select>

      <select
        value={sort}
        onChange={(e) => onSort(e.target.value as SortOrder)}
        aria-label="Sort order"
        className={SELECT_CLASSES}
      >
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first — clear backlog</option>
      </select>
    </div>
  );
}
