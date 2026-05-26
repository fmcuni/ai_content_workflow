"use client";

import { Fragment, useState, type ReactNode } from "react";

import type { PromptGraph, PromptNode } from "@/lib/types";
import { AgentRow } from "./AgentRow";

interface PressWorkflowProps {
  graph: PromptGraph;
  renderInspector: (node: PromptNode) => ReactNode;
}

const SUB_GRAPH_LABELS: Record<string, string> = {
  strategy: "Bureau · Strategy",
  production: "Desk · Production",
  publish: "Press · Publish",
};

export function PressWorkflow({ graph, renderInspector }: PressWorkflowProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const byGroup = new Map<string, PromptNode[]>();
  for (const n of graph.nodes) {
    if (!byGroup.has(n.sub_graph)) byGroup.set(n.sub_graph, []);
    byGroup.get(n.sub_graph)!.push(n);
  }
  for (const arr of byGroup.values()) arr.sort((a, b) => a.order - b.order);

  const gateBefore = new Map<string, typeof graph.gates[number]>(
    graph.gates.map((g) => [g.before, g]),
  );

  let rowIndex = 0;
  return (
    <div>
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
      <p className="mt-4 font-mono text-[11px] tracking-wider text-ink-faint">
        Revision loop · audit → writer, max 3 reviewer rounds
      </p>
    </div>
  );
}
