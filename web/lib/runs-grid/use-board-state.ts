"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import type { TabKey } from "@/lib/desk-items";
import {
  boolDecode,
  boolEncode,
  type Density,
  densityDecode,
  densityEncode,
  LS_COLLAPSE_DONE,
  LS_DENSITY,
  LS_SHOW_WORDPRESS,
  nextDensity,
  parseTab,
} from "@/lib/runs-grid/board-state-codec";

// Board UI state, split by where it belongs:
//   • tab / search / voice  → URL query, so Desk ↔ Ledger links round-trip and a
//     filtered board is shareable / bookmarkable.
//   • collapse-done / density / WordPress-cols → localStorage, an operator's
//     durable view preference that shouldn't ride along in shared links.
// The pure (de)serialisation lives in board-state-codec (unit-tested there).

export type { Density };

/** Read a persisted preference once on mount, falling back to `fallback`. */
function usePersistedState<T>(
  key: string,
  fallback: T,
  decode: (raw: string) => T,
  encode: (value: T) => string,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  // Hydrate from localStorage after mount (SSR-safe: defaults render first).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(key);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (raw !== null) setValue(decode(raw));
    // decode/encode are stable module fns; key is constant per hook instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      if (typeof window !== "undefined") window.localStorage.setItem(key, encode(next));
    },
    [key, encode],
  );

  return [value, set];
}

export interface BoardState {
  tab: TabKey;
  search: string;
  voice: string;
  collapseDone: boolean;
  density: Density;
  showWordpress: boolean;
  setTab: (tab: TabKey) => void;
  setSearch: (search: string) => void;
  setVoice: (voice: string) => void;
  toggleCollapseDone: () => void;
  toggleDensity: () => void;
  toggleWordpress: () => void;
}

export function useBoardState(): BoardState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tab = parseTab(searchParams.get("tab"));
  const search = searchParams.get("q") ?? "";
  const voice = searchParams.get("voice") ?? "";

  // Build the next URL from a fresh params copy (never mutate the shared one),
  // dropping empty values so the URL stays clean.
  const updateQuery = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const setTab = useCallback((next: TabKey) => updateQuery({ tab: next === "all" ? "" : next }), [updateQuery]);
  const setSearch = useCallback((next: string) => updateQuery({ q: next }), [updateQuery]);
  const setVoice = useCallback((next: string) => updateQuery({ voice: next }), [updateQuery]);

  const [collapseDone, setCollapseDone] = usePersistedState(
    LS_COLLAPSE_DONE, false, boolDecode, boolEncode,
  );
  const [density, setDensity] = usePersistedState<Density>(
    LS_DENSITY, "comfortable", densityDecode, densityEncode,
  );
  const [showWordpress, setShowWordpress] = usePersistedState(
    LS_SHOW_WORDPRESS, true, boolDecode, boolEncode,
  );

  return {
    tab,
    search,
    voice,
    collapseDone,
    density,
    showWordpress,
    setTab,
    setSearch,
    setVoice,
    toggleCollapseDone: () => setCollapseDone(!collapseDone),
    toggleDensity: () => setDensity(nextDensity(density)),
    toggleWordpress: () => setShowWordpress(!showWordpress),
  };
}
