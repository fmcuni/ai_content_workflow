import { Badge } from "@/components/ui/badge";

import type { RunStatus } from "@/lib/types";

const COLORS: Record<RunStatus, string> = {
  pending: "bg-neutral-200 text-neutral-800",
  fetching: "bg-blue-100 text-blue-800",
  strategy: "bg-blue-100 text-blue-800",
  hitl_1: "bg-amber-100 text-amber-800",
  production: "bg-indigo-100 text-indigo-800",
  hitl_2: "bg-amber-100 text-amber-800",
  persisted: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
  cancelled: "bg-neutral-200 text-neutral-600",
  rejected: "bg-rose-100 text-rose-800",
  changes_requested: "bg-amber-100 text-amber-800",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge className={COLORS[status]}>{status}</Badge>;
}
