"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "runs-ledger:expanded-themes";

/**
 * Per-theme expand/collapse state for the runs board, persisted to
 * localStorage so a theme a user opened stays open on return. Themes default
 * to **collapsed** (an empty set) — the user only sees children they chose to
 * reveal. SSR-safe: starts empty, hydrates from storage after mount.
 */
export function useExpandedThemes(): {
  expanded: ReadonlySet<string>;
  toggle: (batchId: string) => void;
  isExpanded: (batchId: string) => boolean;
} {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Hydrate after mount (localStorage is unavailable during SSR).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const ids: unknown = JSON.parse(raw);
      if (Array.isArray(ids)) {
        // Hydrate-after-mount is the documented localStorage pattern: reading it
        // in the initializer would diverge from the server render and trip
        // hydration. The one cascading render here is intentional and cheap.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setExpanded(new Set(ids.filter((id): id is string => typeof id === "string")));
      }
    } catch {
      // Corrupt / unavailable storage → keep the default collapsed state.
    }
  }, []);

  const persist = useCallback((next: Set<string>) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Storage full / blocked — collapse state is non-critical, ignore.
    }
  }, []);

  const toggle = useCallback(
    (batchId: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(batchId)) next.delete(batchId);
        else next.add(batchId);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const isExpanded = useCallback((batchId: string) => expanded.has(batchId), [expanded]);

  return { expanded, toggle, isExpanded };
}
