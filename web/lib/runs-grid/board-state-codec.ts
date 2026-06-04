import type { TabKey } from "@/lib/desk-items";

// Pure codecs for the board's persisted UI state, split out from
// `use-board-state.ts` so they can be unit-tested without the Next navigation
// hooks. The hook owns *where* state lives (URL vs localStorage); this module
// owns the (de)serialisation of each value.

export type Density = "comfortable" | "compact";

// localStorage keys for the durable view preferences (operator-scoped, not
// shared in links).
export const LS_COLLAPSE_DONE = "ledger:collapseDone";
export const LS_DENSITY = "ledger:density";
export const LS_SHOW_WORDPRESS = "ledger:showWordpress";

const TAB_KEYS: readonly TabKey[] = ["all", "rewrite", "create", "topic_gen"];

/** URL `?tab=` → a known TabKey, defaulting to "all" for missing/unknown values. */
export function parseTab(value: string | null): TabKey {
  return value && (TAB_KEYS as readonly string[]).includes(value) ? (value as TabKey) : "all";
}

export const boolDecode = (raw: string): boolean => raw === "1";
export const boolEncode = (value: boolean): string => (value ? "1" : "0");

export const densityDecode = (raw: string): Density =>
  raw === "compact" ? "compact" : "comfortable";
export const densityEncode = (value: Density): string => value;

/** Toggle target for the density control. */
export const nextDensity = (value: Density): Density =>
  value === "compact" ? "comfortable" : "compact";
