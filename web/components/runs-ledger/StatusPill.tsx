import { statusIsTransient, statusLabel, statusPill } from "@/lib/run-status";
import { cn } from "@/lib/utils";

interface StatusPillProps {
  status: string;
  className?: string;
}

/**
 * Filled status pill for the ledger (demo `.status-pill`): a coloured dot + the
 * display label, both sourced from the shared run-status helper so labels
 * (`hitl_2`→drafted, `hitl_1`→outlined) and colours stay aligned with every
 * other surface. Transient/in-flight statuses pulse their dot.
 */
export function StatusPill({ status, className }: StatusPillProps) {
  const { pill, dot } = statusPill(status);
  const transient = statusIsTransient(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-semibold",
        pill,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", dot, transient && "animate-pulse")} />
      {statusLabel(status)}
    </span>
  );
}
