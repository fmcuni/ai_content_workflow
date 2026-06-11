import { PaperStamp } from "@/components/PaperStamp";

import type { RunStatus } from "@/lib/types";

type Tone = "neutral" | "accent" | "ok" | "warn" | "info" | "danger";

const TONE: Record<RunStatus, { tone: Tone; pulse?: boolean }> = {
  pending:            { tone: "neutral" },
  fetching:           { tone: "info", pulse: true },
  strategy:           { tone: "info", pulse: true },
  hitl_1:             { tone: "accent" },
  production:         { tone: "info", pulse: true },
  hitl_2:             { tone: "accent" },
  publishing:         { tone: "info", pulse: true },
  revising:           { tone: "info", pulse: true },
  persisted:          { tone: "ok" },
  published:          { tone: "ok" },
  failed:             { tone: "danger" },
  cancelled:          { tone: "neutral" },
  rejected:           { tone: "danger" },
  changes_requested:  { tone: "warn" },
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  pending:            "Queued",
  fetching:           "Fetching article",
  strategy:           "Planning",
  hitl_1:             "Outline review",
  production:         "Drafting",
  hitl_2:             "Draft review",
  publishing:         "Publishing",
  revising:           "Revising",
  persisted:          "Saved",
  published:          "Published",
  failed:             "Failed",
  cancelled:          "Cancelled",
  rejected:           "Rejected",
  changes_requested:  "Changes requested",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const { tone, pulse } = TONE[status] ?? { tone: "neutral" };
  const label = RUN_STATUS_LABEL[status] ?? status.replace(/_/g, " ");
  return <PaperStamp tone={tone} pulse={pulse}>{label}</PaperStamp>;
}
