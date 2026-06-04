// Pure, demo-specified display transforms for the Ledger's run cells. Kept
// React-free and side-effect-free so the CJK slug round-trip and the type/publish
// labels are unit-testable independent of rendering.

import type { RunSummary } from "@/lib/types";

// Single source of truth for slug encode/decode lives in ./slug. Re-exported
// here so existing callers (RunRow) keep importing `decodeSlug` from display.
export { decodeSlug, encodeSlug } from "@/lib/runs-grid/slug";

const PUBLISH_LABEL: Record<string, string> = {
  draft: "Draft",
  future: "Scheduled",
  publish: "Live",
};

/** Human label for a WordPress publish status (defaults to Draft when unset). */
export function publishLabel(status: string | null | undefined): string {
  if (!status) return "Draft";
  return PUBLISH_LABEL[status] ?? status;
}

/** Whether a publish status pushes a public, live post. */
export function isLivePublish(status: string | null | undefined): boolean {
  return status === "publish";
}

export interface RunTypeChip {
  glyph: string;
  label: string;
}

/** Type chip for a run: ✦ New article, or ↻ Rewrite · Full|Small. */
export function runTypeChip(run: RunSummary): RunTypeChip {
  if (run.start_mode === "create") return { glyph: "✦", label: "New article" };
  if (run.chosen_route === "full_rewrite") return { glyph: "↻", label: "Rewrite · Full" };
  if (run.chosen_route === "small_refresh") return { glyph: "↻", label: "Rewrite · Small" };
  return { glyph: "↻", label: "Rewrite" };
}

/**
 * Compact `host/path` for a rewrite's source link (the full URL is the href).
 * Strips the scheme and any trailing slash.
 */
export function hostPath(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

/** A ledger date — short weekday + 24h time, matching the Desk's ledgerDate. */
export function ledgerDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}
