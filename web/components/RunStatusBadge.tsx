import { PaperStamp } from "@/components/PaperStamp";
import { statusIsTransient, statusLabel, statusStampTone } from "@/lib/run-status";

import type { RunStatus } from "@/lib/types";

// Canonical run-status badge. Labels + tones come from the shared run-status
// helper (web/lib/run-status.ts) so "drafted" / "outlined" and pill colours stay
// consistent with the ledger and every other run surface.
export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <PaperStamp tone={statusStampTone(status)} pulse={statusIsTransient(status)}>
      {statusLabel(status)}
    </PaperStamp>
  );
}
