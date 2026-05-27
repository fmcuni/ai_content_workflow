"use client";

import { Fragment, useState, type ReactNode } from "react";

import type { GraphMode, PromptGraph, PromptNode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AgentRow } from "./AgentRow";

interface PressWorkflowProps {
  graph: PromptGraph;
  mode: GraphMode;
  onModeChange: (mode: GraphMode) => void;
  renderInspector: (node: PromptNode) => ReactNode;
}

const MODES: { mode: GraphMode; label: string }[] = [
  { mode: "refresh", label: "Rewrite" },
  { mode: "create", label: "Create" },
  { mode: "topic_expansion", label: "Topic Expansion" },
];

const SUB_GRAPH_LABELS: Record<string, string> = {
  strategy: "Bureau · Strategy",
  production: "Desk · Production",
  publish: "Press · Publish",
  generate: "Brief · Generate",
  analyse: "Fan-out · Analyse",
};

export function PressWorkflow({ graph, mode, onModeChange, renderInspector }: PressWorkflowProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  // A node expanded in one mode may not exist in another — collapse on switch.
  const switchMode = (m: GraphMode) => {
    setExpanded(null);
    onModeChange(m);
  };

  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  const byGroup = new Map<string, PromptNode[]>();
  for (const n of graph.nodes) {
    if (!byGroup.has(n.sub_graph)) byGroup.set(n.sub_graph, []);
    byGroup.get(n.sub_graph)!.push(n);
  }
  for (const arr of byGroup.values()) arr.sort((a, b) => a.order - b.order);

  const gateBefore = new Map<string, typeof graph.gates[number]>(
    graph.gates.map((g) => [g.before, g]),
  );
  // Gates whose anchor node isn't in this graph (e.g. HITL_T1 → "__end__")
  // render as a trailing review bar after the last group.
  const trailingGates = graph.gates.filter((g) => !nodeIds.has(g.before));

  const hasAudit = nodeIds.has("audit");

  let rowIndex = 0;
  return (
    <div>
      {/* Pipeline mode toggle */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-2">
        <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint">
          Pipeline
        </span>
        <div className="inline-flex border border-rule divide-x divide-rule">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={m.mode === mode}
              onClick={() => switchMode(m.mode)}
              className={cn(
                "font-mono text-[11px] tracking-[0.16em] uppercase px-3 py-1.5 transition-colors",
                m.mode === mode
                  ? "bg-ink text-paper"
                  : "text-ink-faint hover:bg-paper-deep/40 hover:text-ink",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {graph.summary && (
        <p className="text-[14px] text-ink-soft max-w-[72ch] pb-2">{graph.summary}</p>
      )}

      {Array.from(byGroup.entries()).map(([sub, nodes]) => (
        <Fragment key={sub}>
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint pt-6 pb-2">
            {SUB_GRAPH_LABELS[sub] ?? sub}
          </p>
          {nodes.map((node) => {
            rowIndex += 1;
            const gate = gateBefore.get(node.id);
            return (
              <Fragment key={node.id}>
                {gate && (
                  <div className="my-3 flex items-center gap-3">
                    <div className="h-[3px] flex-1 bg-ink" />
                    <span className="font-mono text-[11px] tracking-[0.24em] uppercase text-ink">
                      {gate.label}
                    </span>
                    <div className="h-[3px] flex-1 bg-ink" />
                  </div>
                )}
                <AgentRow
                  index={rowIndex}
                  node={node}
                  expanded={expanded === node.id}
                  onToggle={() => setExpanded((e) => (e === node.id ? null : node.id))}
                  expandable={node.kind === "llm"}
                >
                  {renderInspector(node)}
                </AgentRow>
              </Fragment>
            );
          })}
        </Fragment>
      ))}

      {trailingGates.map((gate) => (
        <div key={gate.id} className="my-3 flex items-center gap-3">
          <div className="h-[3px] flex-1 bg-ink" />
          <span className="font-mono text-[11px] tracking-[0.24em] uppercase text-ink">
            {gate.label}
          </span>
          <div className="h-[3px] flex-1 bg-ink" />
        </div>
      ))}

      {hasAudit && (
        <p className="mt-4 font-mono text-[11px] tracking-wider text-ink-faint">
          Revision loop · audit → writer, max 3 reviewer rounds
        </p>
      )}
    </div>
  );
}
