// Pure, React-free transforms backing the run-expand preview (Phase 2). Kept
// side-effect-free so the HTML H2 parse, the audit roll-up and the cost format
// are unit-testable independent of rendering.

import type { Audit, RunCost } from "@/lib/types";

// How many H2 chips to show before collapsing the rest into a "+N more" chip.
const H2_CAP = 6;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Strip any inner markup (`<strong>`, `<br>`, …) from an H2's inner HTML. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** Decode the small set of named/numeric entities that show up in headings. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/**
 * Parse the H2 headings out of a rendered article body, in document order. Each
 * is de-tagged, entity-decoded and trimmed; empty headings are dropped. When
 * there are more than `cap`, the overflow collapses into a trailing "+N more"
 * chip so the preview stays one tidy row.
 */
export function extractH2s(htmlBody: string | null | undefined, cap: number = H2_CAP): string[] {
  if (!htmlBody) return [];
  const matches = [...htmlBody.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  const headings = matches
    .map((m) => decodeEntities(stripTags(m[1])).trim())
    .filter((h) => h.length > 0);
  if (headings.length <= cap) return headings;
  const shown = headings.slice(0, cap);
  return [...shown, `+${headings.length - cap} more`];
}

export interface AuditSummary {
  pass: boolean;
  high: number;
  medium: number;
  low: number;
}

/**
 * Roll an audit row up to the verdict + severity counts the preview stamps show.
 * A missing audit is treated as a non-pass with zero findings (the caller draws
 * the graceful "no audit yet" state separately for the not-found case).
 */
export function auditSummary(audit: Audit | null | undefined): AuditSummary {
  if (!audit) return { pass: false, high: 0, medium: 0, low: 0 };
  return {
    pass: audit.overall_pass,
    high: audit.severity_high,
    medium: audit.severity_medium,
    low: audit.severity_low,
  };
}

/**
 * Format integer cents as a money string. Matches the batch band's `HK$ X.XX`
 * convention so the board reads consistently; returns "—" when no cost is known.
 */
export function formatCostCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `HK$ ${(cents / 100).toFixed(2)}`;
}

/** Cost + iteration one-liner for the preview, e.g. "HK$ 1.86 · 2 it". */
export function costLine(cost: RunCost | null | undefined, iterations: number): string {
  return `${formatCostCents(cost?.est_usd_cents)} · ${iterations} it`;
}
