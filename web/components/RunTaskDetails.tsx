"use client";
import Link from "next/link";

import { ExternalLink } from "@/components/ExternalLink";
import { useTopicBatchForRun } from "@/lib/run-editor/useTopicBatchForRun";
import type { RunSummary } from "@/lib/types";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className="font-sans text-[13px] text-ink mt-0.5 break-words">{value}</dd>
    </div>
  );
}

function WideField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="col-span-2 md:col-span-4 min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className="font-sans text-[13px] text-ink mt-0.5 break-words">{children}</dd>
    </div>
  );
}

/**
 * Task-config readout for a run — source URL (rewrite), focus keywords, voice
 * (persona), mode (rewrite only), advertiser/widget ids, the operator's edit
 * note, and the topic batch it was promoted from. Shown atop the run detail and
 * both HITL gates so the editor sees what the run was commissioned to do.
 */
export function RunTaskDetails({ run }: { run: RunSummary }) {
  const isCreate = run.start_mode === "create";
  const keywords = run.keywords ?? [];
  const batch = useTopicBatchForRun(run);

  return (
    <section className="border border-rule rounded bg-paper-deep/30 px-4 py-3 mb-8">
      <p className="kicker mb-2">
        Task brief · {isCreate ? "Create article" : "Rewrite article"}
      </p>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
        <div className="col-span-2 md:col-span-4 min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            Topic
          </dt>
          <dd className="font-sans text-[14px] text-ink mt-0.5 break-words">
            {run.topic || <span className="text-ink-faint italic">—</span>}
          </dd>
        </div>

        {/* Source article being rewritten — rewrite/refresh runs only. */}
        {!isCreate && run.article_url && (
          <WideField label="Source URL">
            <ExternalLink
              href={run.article_url}
              className="text-accent hover:underline underline-offset-2 break-all"
            >
              {run.article_url} <span className="text-ink-faint">↗</span>
            </ExternalLink>
          </WideField>
        )}

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
        <Field label="Voice" value={run.persona ?? "none"} />
        {!isCreate && <Field label="Mode" value={run.mode} />}
        {/* 0 is the unset sentinel for these ACF ids, so show it as "none" too. */}
        <Field label="Adv ID" value={run.acf_adv_id || "none"} />
        <Field label="Widget ID" value={run.acf_widget_id || "none"} />

        {/* Operator's note that seeded / steers this run. */}
        {run.edit_note && (
          <WideField label="Edit note">
            <span className="whitespace-pre-wrap">{run.edit_note}</span>
          </WideField>
        )}

        {/* The Expand-Topics batch this run was promoted from, when applicable. */}
        {batch && (
          <WideField label="Topic batch">
            <Link
              href={`/topic-batches/${batch.batch_id}`}
              className="text-accent hover:underline underline-offset-2"
            >
              №{batch.batch_id.slice(0, 8)} ·{" "}
              <span className="text-ink">&ldquo;{batch.research_theme}&rdquo;</span>
            </Link>
          </WideField>
        )}
      </dl>
    </section>
  );
}
