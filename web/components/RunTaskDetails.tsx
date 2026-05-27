"use client";
import type { RunSummary } from "@/lib/types";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className="font-sans text-[13px] text-ink mt-0.5 break-words">{value}</dd>
    </div>
  );
}

/**
 * Task-config readout for a run — focus keywords, voice (persona), mode (rewrite
 * only), advertiser id and widget id. Shown atop the run detail and both HITL
 * gates so the editor sees what the run was commissioned to do.
 */
export function RunTaskDetails({ run }: { run: RunSummary }) {
  const isCreate = run.start_mode === "create";
  const keywords = run.keywords ?? [];

  return (
    <section className="border border-rule rounded bg-paper-deep/30 px-4 py-3 mb-8">
      <p className="kicker mb-2">
        Task brief · {isCreate ? "Create article" : "Rewrite article"}
      </p>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
        <div className="col-span-2 md:col-span-4 min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            Focus keywords
          </dt>
          <dd className="mt-1">
            {keywords.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {keywords.map((kw) => (
                  <li
                    key={kw}
                    className="font-mono text-[11px] tracking-[0.04em] text-ink-soft border border-rule rounded-sm px-1.5 py-0.5 bg-paper"
                  >
                    {kw}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="font-sans text-[13px] text-ink-faint italic">none</span>
            )}
          </dd>
        </div>
        <Field label="Voice" value={run.persona ?? "—"} />
        {!isCreate && <Field label="Mode" value={run.mode} />}
        <Field label="Adv ID" value={run.acf_adv_id ?? "—"} />
        <Field label="Widget ID" value={run.acf_widget_id ?? "—"} />
      </dl>
    </section>
  );
}
