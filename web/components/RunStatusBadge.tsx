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
  persisted:          { tone: "ok" },
  failed:             { tone: "danger" },
  cancelled:          { tone: "neutral" },
  rejected:           { tone: "danger" },
  changes_requested:  { tone: "warn" },
};

const LABEL: Partial<Record<RunStatus, string>> = {
  hitl_1: "HITL · 1",
  hitl_2: "HITL · 2",
  changes_requested: "CHANGES",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const { tone, pulse } = TONE[status] ?? { tone: "neutral" };
  const label = LABEL[status] ?? status.toUpperCase();
  return <PaperStamp tone={tone} pulse={pulse}>{label}</PaperStamp>;
}
