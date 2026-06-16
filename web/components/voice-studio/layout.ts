import type { Edge, Node } from "@xyflow/react";

import type { PromptGraph, PromptNode } from "@/lib/types";

// How a template resolves for the selected voice: the voice has its own row
// (`overridden`), it inherits the `__shared__` seed, or the node has no
// editable system prompt at all (deterministic step).
export type Ownership = "overridden" | "shared" | "none";

export interface AgentNodeData extends Record<string, unknown> {
  node: PromptNode;
  ownership: Ownership;
}
export interface PartialNodeData extends Record<string, unknown> {
  templateId: string;
  consumerCount: number;
  ownership: Ownership;
}
export interface GateNodeData extends Record<string, unknown> {
  label: string;
  description: string;
}

export type StudioNode =
  | Node<AgentNodeData, "agent">
  | Node<PartialNodeData, "partial">
  | Node<GateNodeData, "gate">;

// A partial template plus the agent template ids that {{include:}} it (reversed
// from GET /templates/:id/consumers). Drives the dotted include-edges.
export interface PartialInfo {
  templateId: string;
  consumers: string[];
  ownership: Ownership;
}

// Canonical left→right ordering of the sub-graphs across all three modes.
const SUB_GRAPH_RANK: Record<string, number> = {
  strategy: 0,
  production: 1,
  publish: 2,
  generate: 0,
  analyse: 1,
};

const X_GAP = 300;
const SPINE_Y = 0;
const GATE_Y = -160;
const PARTIAL_Y = 230;
const PARTIAL_X_GAP = 260;

function rankNode(n: PromptNode): [number, number] {
  return [SUB_GRAPH_RANK[n.sub_graph] ?? 99, n.order];
}

/** Linear pipeline order: sub-graph rank, then per-node order. */
function sortedAgents(graph: PromptGraph): PromptNode[] {
  return [...graph.nodes].sort((a, b) => {
    const [ra, oa] = rankNode(a);
    const [rb, ob] = rankNode(b);
    return ra !== rb ? ra - rb : oa - ob;
  });
}

export interface StudioGraph {
  nodes: StudioNode[];
  edges: Edge[];
}

/**
 * Pure transform: a fixed `PromptGraph` (one mode) + the voice's partial
 * include-map + per-template ownership → positioned React Flow nodes/edges.
 * No data fetching, no side effects — safe to recompute on every mode change.
 */
export function buildStudioGraph(
  graph: PromptGraph,
  partials: PartialInfo[],
  ownershipById: Record<string, Ownership>,
): StudioGraph {
  const agents = sortedAgents(graph);
  const nodeIds = new Set(agents.map((n) => n.id));
  // Sequence index per agent — used to spot backward (loop-back) edges.
  const seqIndex = new Map<string, number>(agents.map((n, i) => [n.id, i]));

  const ownershipFor = (n: PromptNode): Ownership => {
    if (!n.system_prompt_template_id) return "none";
    return ownershipById[n.system_prompt_template_id] ?? "shared";
  };

  const agentNodes: StudioNode[] = agents.map((n, i) => ({
    id: n.id,
    type: "agent",
    position: { x: i * X_GAP, y: SPINE_Y },
    data: { node: n, ownership: ownershipFor(n) },
  }));

  // Gates: those anchored to a node in this graph float above that node; gates
  // anchored to "__end__" (e.g. HITL_T1) trail after the last agent.
  const gateNodes: StudioNode[] = [];
  const gateEdges: Edge[] = [];
  let trailing = 0;
  for (const g of graph.gates) {
    const anchorIndex = seqIndex.get(g.before);
    if (anchorIndex === undefined) {
      gateNodes.push({
        id: `gate:${g.id}`,
        type: "gate",
        position: { x: (agents.length + trailing) * X_GAP, y: SPINE_Y },
        data: { label: g.label, description: g.description },
      });
      trailing += 1;
      continue;
    }
    gateNodes.push({
      id: `gate:${g.id}`,
      type: "gate",
      position: { x: anchorIndex * X_GAP, y: GATE_Y },
      data: { label: g.label, description: g.description },
    });
    gateEdges.push({
      id: `gate-edge:${g.id}`,
      source: `gate:${g.id}`,
      sourceHandle: "g-out",
      target: g.before,
      targetHandle: "gate",
      style: { stroke: "var(--color-ink-faint)", strokeDasharray: "3 3" },
    });
  }

  // Partials sit in a row below the spine; only those whose consumers are in
  // this mode's graph are shown (an unused partial would dangle).
  const visiblePartials = partials.filter((p) =>
    p.consumers.some((c) => nodeIds.has(c)),
  );
  const partialNodes: StudioNode[] = visiblePartials.map((p, i) => ({
    id: `partial:${p.templateId}`,
    type: "partial",
    position: { x: i * PARTIAL_X_GAP, y: PARTIAL_Y },
    data: {
      templateId: p.templateId,
      consumerCount: p.consumers.filter((c) => nodeIds.has(c)).length,
      ownership: p.ownership,
    },
  }));

  // Spine edges from the graph topology. A target earlier in the sequence than
  // its source is a loop-back (audit → writer refine loop) — styled in rust.
  const spineEdges: Edge[] = graph.edges
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => {
      const si = seqIndex.get(e.from)!;
      const ti = seqIndex.get(e.to)!;
      const isLoopBack = ti <= si;
      return {
        id: `spine:${e.from}->${e.to}`,
        source: e.from,
        sourceHandle: "out",
        target: e.to,
        targetHandle: "in",
        label: e.label ?? (isLoopBack ? "refine loop" : undefined),
        animated: isLoopBack,
        style: isLoopBack
          ? { stroke: "var(--color-accent)", strokeWidth: 1.5 }
          : { stroke: "var(--color-ink-soft)" },
        labelStyle: isLoopBack
          ? { fill: "var(--color-accent)", fontFamily: "var(--font-mono)", fontSize: 10 }
          : { fill: "var(--color-ink-faint)", fontFamily: "var(--font-mono)", fontSize: 10 },
      };
    });

  // Dotted hairline include-edges: partial → each consumer agent in this mode.
  const includeEdges: Edge[] = visiblePartials.flatMap((p) =>
    p.consumers
      .filter((c) => nodeIds.has(c))
      .map((c) => ({
        id: `inc:${p.templateId}->${c}`,
        source: `partial:${p.templateId}`,
        sourceHandle: "p-out",
        target: c,
        targetHandle: "inc",
        style: { stroke: "var(--color-rule)", strokeDasharray: "2 4" },
      })),
  );

  return {
    nodes: [...agentNodes, ...gateNodes, ...partialNodes],
    edges: [...spineEdges, ...gateEdges, ...includeEdges],
  };
}
