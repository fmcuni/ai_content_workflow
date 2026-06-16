"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { PromptEditor } from "@/components/prompts/PromptEditor";
import { promptsApi } from "@/lib/api";
import type { PromptNode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { VoiceConfigInspector, type VoiceConfigTab } from "./VoiceConfigInspector";

// Agents whose user prompt the backend can rebuild from a real run
// (GET /user-example). Others (topic_*, deterministic) take per-batch /
// per-candidate input — there's no single run to sample.
const RUN_SAMPLED_AGENTS = new Set(["gap_analysis", "outline", "writer", "audit"]);

export type StudioSelection =
  | { kind: "agent"; node: PromptNode }
  | { kind: "partial"; templateId: string }
  | { kind: "gate"; label: string; description: string }
  | { kind: "voice-config"; tab: VoiceConfigTab };

interface StudioInspectorProps {
  selection: StudioSelection;
  voice: string;
  /** Anchored run from the page header — feeds the real-run user-prompt tab. */
  runId: string | null;
  onClose: () => void;
}

function RealRunUserPrompt({ agent, runId }: { agent: string; runId: string | null }) {
  const sampled = RUN_SAMPLED_AGENTS.has(agent);

  const exampleQ = useQuery({
    enabled: sampled && runId !== null,
    queryKey: ["user-example", runId, agent],
    queryFn: () => promptsApi.userExample(runId!, agent),
    retry: false,
  });

  if (!sampled) {
    return (
      <p className="text-ink-soft text-[12px] leading-relaxed">
        This step takes per-batch / per-candidate input — there’s no single run
        to sample a filled user prompt from.
      </p>
    );
  }
  if (!runId) {
    return (
      <p className="text-ink-faint text-[12px]">
        Pick a run in the header to see this agent’s user prompt filled with real
        values.
      </p>
    );
  }
  if (exampleQ.isPending) {
    return <p className="text-ink-faint text-[12px]">Loading example…</p>;
  }
  if (exampleQ.isError) {
    return (
      <p className="text-ink-soft text-[12px] leading-relaxed">
        This agent didn’t run in the selected run (no recorded inputs). Try a run
        that reached this stage.
      </p>
    );
  }
  return (
    <pre className="font-mono text-[11.5px] leading-[1.55] text-ink-soft bg-paper-deep/30 border border-rule rounded-sm p-3 whitespace-pre-wrap max-h-[70vh] overflow-auto">
      {exampleQ.data?.prompt}
    </pre>
  );
}

function AgentInspector({
  node,
  voice,
  runId,
}: {
  node: PromptNode;
  voice: string;
  runId: string | null;
}) {
  const templateIds = [
    node.system_prompt_template_id,
    ...(node.alt_template_ids ?? []),
  ].filter((x): x is string => Boolean(x));

  const [activeTemplate, setActiveTemplate] = useState(templateIds[0] ?? null);
  const [tab, setTab] = useState<"prompt" | "run">("prompt");

  if (templateIds.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-ink-soft text-[13px] leading-relaxed">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Deterministic step
          </span>
          <br />
          {node.description || node.id} has no editable system prompt — it runs in
          code, not via the LLM.
        </p>
        <div>
          <h3 className="kicker mb-2">Real-run user prompt</h3>
          <RealRunUserPrompt agent={node.id} runId={runId} />
        </div>
      </div>
    );
  }

  return (
    <div>
      {templateIds.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {templateIds.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTemplate(id)}
              className={cn(
                "font-mono text-[10px] uppercase tracking-wider border rounded-sm px-2 py-0.5 transition-colors",
                id === activeTemplate
                  ? "border-accent text-accent bg-accent/5"
                  : "border-rule text-ink-faint hover:text-ink",
              )}
            >
              {id}
            </button>
          ))}
        </div>
      )}

      <div className="inline-flex border border-rule divide-x divide-rule mb-4">
        {(
          [
            ["prompt", "Edit & assemble"],
            ["run", "Real run"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "font-mono text-[11px] tracking-[0.14em] uppercase px-3 py-1.5 transition-colors",
              tab === key ? "bg-ink text-paper" : "text-ink-faint hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "prompt" && activeTemplate && (
        <PromptEditor templateId={activeTemplate} voice={voice} compact />
      )}
      {tab === "run" && (
        <div>
          <p className="text-ink-faint text-[11px] mb-2 leading-snug">
            The user prompt this agent sent, filled from the anchored run — the
            real-data illustration of the assembled system prompt on the left tab.
          </p>
          <RealRunUserPrompt agent={node.id} runId={runId} />
        </div>
      )}
    </div>
  );
}

/**
 * Right-docked, polymorphic inspector. Agent → tabbed editor (assembled system
 * prompt + JSON schema via the shared PromptEditor) and a real-run user prompt;
 * partial → the shared editor; gate → a read-only description.
 */
export function StudioInspector({ selection, voice, runId, onClose }: StudioInspectorProps) {
  const title =
    selection.kind === "agent"
      ? selection.node.id
      : selection.kind === "partial"
        ? selection.templateId
        : selection.kind === "gate"
          ? selection.label
          : voice;
  const kicker =
    selection.kind === "agent"
      ? "Agent"
      : selection.kind === "partial"
        ? "Partial · shared include"
        : selection.kind === "gate"
          ? "Human-in-the-loop gate"
          : "Voice context";

  return (
    <div className="flex h-full flex-col bg-paper border-l border-rule">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-rule">
        <div className="min-w-0">
          <p className="kicker">{kicker}</p>
          <h2 className="font-display text-[19px] text-ink truncate">{title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="font-mono text-[11px] uppercase tracking-wider text-ink-faint hover:text-accent shrink-0"
        >
          Close ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {selection.kind === "agent" && (
          <AgentInspector key={selection.node.id} node={selection.node} voice={voice} runId={runId} />
        )}
        {selection.kind === "partial" && (
          <PromptEditor templateId={selection.templateId} voice={voice} compact />
        )}
        {selection.kind === "gate" && (
          <p className="text-ink-soft text-[13px] leading-relaxed">{selection.description}</p>
        )}
        {selection.kind === "voice-config" && (
          <VoiceConfigInspector voice={voice} initialTab={selection.tab} />
        )}
      </div>
    </div>
  );
}
