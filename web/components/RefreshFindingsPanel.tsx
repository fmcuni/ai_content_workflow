import { PaperStamp } from "@/components/PaperStamp";
import { cn } from "@/lib/utils";
import type { RefreshEvaluation } from "@/lib/types";

interface RefreshFindingsPanelProps {
  ev: RefreshEvaluation;
  className?: string;
}

const SEVERITY_TONE = {
  high: "danger",
  medium: "warn",
  low: "neutral",
} as const;

const SEVERITY_LABEL = {
  high: "HIGH",
  medium: "MED",
  low: "LOW",
} as const;

export function RefreshFindingsPanel({ ev, className }: RefreshFindingsPanelProps) {
  const { deterministic_findings, llm_findings, llm_skipped_reason } = ev;
  const findings = deterministic_findings?.findings ?? [];

  const actionTone =
    ev.recommended_action === "refresh" ? "accent" :
    ev.recommended_action === "monitor" ? "warn" :
    "neutral";

  return (
    <blockquote className={cn("border-l-2 border-accent pl-5 space-y-5 text-[13px]", className)}>
      <p className="kicker">Brief from Archive</p>

      <div className="flex flex-wrap gap-3 items-center font-mono text-[12px] text-ink-soft">
        <span>STALENESS · <span className="text-ink tabular-nums">{Number(ev.staleness_score).toFixed(1)}</span></span>
        <span className="text-ink-faint">·</span>
        <PaperStamp tone={actionTone}>{ev.recommended_action}</PaperStamp>
        <span className="text-ink-faint">·</span>
        <span>AGE · <span className="text-ink tabular-nums">{ev.age_days}d</span></span>
      </div>

      <section>
        <p className="kicker mb-3">
          Deterministic findings · {deterministic_findings?.severity_high ?? 0}H · {deterministic_findings?.severity_medium ?? 0}M · {deterministic_findings?.severity_low ?? 0}L
        </p>
        {findings.length === 0 ? (
          <p className="text-ink-faint italic font-display">No findings.</p>
        ) : (
          <ol className="space-y-2.5 list-none">
            {findings.map((f, i) => (
              <li key={f.id} className="grid grid-cols-[28px_56px_1fr] gap-3 items-start">
                <span className="font-mono text-[12px] text-ink-faint tabular-nums pt-[2px]">{String(i + 1).padStart(2, "0")}.</span>
                <PaperStamp tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</PaperStamp>
                <span className="text-ink">{f.message}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <p className="kicker mb-2">LLM audit</p>
        {llm_skipped_reason ? (
          <p className="text-ink-faint text-[12px]">Skipped: {llm_skipped_reason}</p>
        ) : llm_findings ? (
          <pre className="bg-paper-deep p-3 text-[11px] font-mono overflow-auto max-h-48 whitespace-pre-wrap border border-rule">
            {JSON.stringify(llm_findings, null, 2)}
          </pre>
        ) : (
          <p className="text-ink-faint text-[12px]">No LLM findings.</p>
        )}
      </section>
    </blockquote>
  );
}
