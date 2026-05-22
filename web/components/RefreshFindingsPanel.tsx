import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RefreshEvaluation } from "@/lib/types";

interface RefreshFindingsPanelProps {
  ev: RefreshEvaluation;
  className?: string;
}

const severityVariant = {
  high: "destructive",
  medium: "secondary",
  low: "outline",
} as const;

const severityLabel = {
  high: "High",
  medium: "Medium",
  low: "Low",
} as const;

export function RefreshFindingsPanel({ ev, className }: RefreshFindingsPanelProps) {
  const { deterministic_findings, llm_findings, llm_skipped_reason } = ev;
  const findings = deterministic_findings?.findings ?? [];

  return (
    <div className={cn("space-y-4 text-sm", className)}>
      {/* Header summary badges */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="font-medium">Staleness:</span>
        <span className="font-mono">{Number(ev.staleness_score).toFixed(1)}</span>
        <Badge
          variant={
            ev.recommended_action === "refresh"
              ? "destructive"
              : ev.recommended_action === "monitor"
              ? "secondary"
              : "outline"
          }
        >
          {ev.recommended_action}
        </Badge>
        <span className="text-muted-foreground text-xs">
          Age: {ev.age_days}d
        </span>
      </div>

      {/* Deterministic findings */}
      <section>
        <h4 className="font-medium mb-2">
          Deterministic findings
          <span className="ml-2 text-xs text-muted-foreground">
            {deterministic_findings?.severity_high ?? 0}H ·{" "}
            {deterministic_findings?.severity_medium ?? 0}M ·{" "}
            {deterministic_findings?.severity_low ?? 0}L
          </span>
        </h4>
        {findings.length === 0 ? (
          <p className="text-muted-foreground">No findings.</p>
        ) : (
          <ul className="space-y-1.5">
            {findings.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <Badge
                  variant={severityVariant[f.severity]}
                  className="mt-0.5 shrink-0"
                >
                  {severityLabel[f.severity]}
                </Badge>
                <span className="text-foreground">{f.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* LLM audit */}
      <section>
        <h4 className="font-medium mb-2">LLM audit</h4>
        {llm_skipped_reason ? (
          <p className="text-muted-foreground text-xs">
            Skipped: {llm_skipped_reason}
          </p>
        ) : llm_findings ? (
          <pre className="bg-muted rounded p-2 text-xs overflow-auto max-h-48 whitespace-pre-wrap">
            {JSON.stringify(llm_findings, null, 2)}
          </pre>
        ) : (
          <p className="text-muted-foreground text-xs">No LLM findings.</p>
        )}
      </section>
    </div>
  );
}
