import type { RunStatus } from "@/lib/types";

// ── Shared run-status presentation ──────────────────────────────────────────
// Single source of truth for how a run's pipeline status is *labelled* and
// *coloured* across every page (ledger, run detail, /hitl2, /edit, grid, desk).
// Mirrors the redesign demo (design/runs-redesign/runs-redesign.html §STATUS_META
// + .st-* classes) and §2 of the runs-ledger spec.
//
// Invariant (regression-guarded by commit ae44135): NO live status may be
// unmapped. Every status — including transient/in-flight ones (fetching,
// strategy, production, publishing, revising) — resolves to a non-empty label
// and a coloured pill, so a run can never render an empty/invisible badge.
// Unknown strings fall back to the safe in-progress (blue) tone rather than
// disappearing.

// Editorial accent buckets, matching the demo's status palette.
//   amber → gates awaiting an operator (hitl_1 / hitl_2)
//   blue  → pending + any transient/in-flight working state
//   green → durable success (persisted / published)
//   red   → failed
//   gray  → inert terminal (cancelled / rejected)
export type StatusTone = "amber" | "blue" | "green" | "red" | "gray";

// hitl_2 → "drafted", hitl_1 → "outlined"; every other status renders under its
// literal name (spec §2). Kept tiny on purpose — the literal name is the demo's
// fallback too, so new backend statuses surface verbatim instead of vanishing.
const STATUS_LABEL: Partial<Record<RunStatus, string>> = {
  hitl_2: "drafted",
  hitl_1: "outlined",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status as RunStatus] ?? status;
}

// Exhaustive tone map over the full RunStatus union. Adding a status to the
// union without mapping it here is a compile error (Record, not Partial).
const STATUS_TONE: Record<RunStatus, StatusTone> = {
  pending: "blue",
  fetching: "blue",
  strategy: "blue",
  hitl_1: "amber",
  production: "blue",
  hitl_2: "amber",
  publishing: "blue",
  revising: "blue",
  persisted: "green",
  published: "green",
  failed: "red",
  cancelled: "gray",
  rejected: "gray",
  changes_requested: "amber",
};

// Unknown status → "blue" (in-progress): a status we don't recognise is far more
// likely a new transient pipeline state than a terminal one, and blue keeps the
// run visible rather than hiding it.
export function statusTone(status: string): StatusTone {
  return STATUS_TONE[status as RunStatus] ?? "blue";
}

// Transient = the pipeline is actively working; consumers pulse the badge.
const TRANSIENT: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "fetching",
  "strategy",
  "production",
  "publishing",
  "revising",
]);

export function statusIsTransient(status: string): boolean {
  return TRANSIENT.has(status as RunStatus);
}

// Statuses where the article body has been produced — a draft exists to preview
// and to preserve as a snapshot baseline, even if SEO title/meta are still unset.
// Excludes pre-draft states (pending/fetching/strategy/hitl_1/production) and
// terminal-without-draft states (failed/cancelled/rejected).
const HAS_DRAFT: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "hitl_2",
  "publishing",
  "revising",
  "persisted",
  "published",
  "changes_requested",
]);

export function statusHasDraft(status: string): boolean {
  return HAS_DRAFT.has(status as RunStatus);
}

// Filled-pill Tailwind classes (background + text + dot) for the redesign ledger
// and any consumer wanting the demo's pill, using the app's existing editorial
// tokens (warn/info/ok/accent/ink-soft) — NOT a forked colour system. `pill`
// goes on the badge container, `dot` on the leading status dot.
export interface StatusPillStyle {
  pill: string;
  dot: string;
}

const TONE_PILL: Record<StatusTone, StatusPillStyle> = {
  amber: { pill: "bg-warn/10 text-warn", dot: "bg-warn" },
  blue: { pill: "bg-info/10 text-info", dot: "bg-info" },
  green: { pill: "bg-ok/10 text-ok", dot: "bg-ok" },
  red: { pill: "bg-accent/10 text-accent-deep", dot: "bg-accent-deep" },
  gray: { pill: "bg-ink-soft/10 text-ink-soft", dot: "bg-ink-soft" },
};

export function statusPill(status: string): StatusPillStyle {
  return TONE_PILL[statusTone(status)];
}

// Bridge for the existing PaperStamp badge, whose tone vocabulary differs from
// the demo's colour buckets. Keeps the outlined-stamp pages on the shared map.
export type StampTone = "neutral" | "accent" | "ok" | "warn" | "info" | "danger";

const TONE_STAMP: Record<StatusTone, StampTone> = {
  amber: "warn",
  blue: "info",
  green: "ok",
  red: "danger",
  gray: "neutral",
};

export function statusStampTone(status: string): StampTone {
  return TONE_STAMP[statusTone(status)];
}
