import type { Edge, Node } from "@xyflow/react";

import type { PromptGraph, PromptNode } from "@/lib/types";
import { contextId, gateId, partialId } from "./node-id";
import type { NodeRunStatus, RunOverlay } from "./run-overlay";

// How a template resolves for the selected voice: the voice has its own row
// (`overridden`), it inherits the `__shared__` seed, or the node has no
// editable system prompt at all (deterministic step).
export type Ownership = "overridden" | "shared" | "none";

export interface AgentNodeData extends Record<string, unknown> {
  node: PromptNode;
  ownership: Ownership;
  // Execution status from the anchored run (PR3 run-chip overlay). Undefined
  // when no run is anchored or the run ran in a different mode — the card then
  // shows no chip.
  runStatus?: NodeRunStatus;
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
// Voice-level context (locale, source policy) that is substituted into the
// assembled prompt of every persona-using agent. Rendered as input nodes with
// inject-edges so the edit blast-radius is visible.
export type ContextKind = "locale" | "source_policy";
export interface ContextNodeData extends Record<string, unknown> {
  kind: ContextKind;
  label: string;
  injectCount: number;
}

export type StudioNode =
  | Node<AgentNodeData, "agent">
  | Node<PartialNodeData, "partial">
  | Node<GateNodeData, "gate">
  | Node<ContextNodeData, "context">;

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

// Cards are 220px wide; a 260px column gap keeps a clear lane between them while
// compressing the overall spread so the initial fit-view zoom stays readable.
const X_GAP = 260;
const SPINE_Y = 0;
const GATE_Y = -160;
const PARTIAL_Y = 230;
const PARTIAL_X_GAP = 260;
// Voice-context inputs sit at the top, above the gate band, and inject down
// into every persona-using agent.
const CONTEXT_Y = -360;
const CONTEXT_X_GAP = 230;
const CONTEXT_DEFS: { kind: ContextKind; id: string; label: string }[] = [
  { kind: "locale", id: contextId("locale"), label: "Locale" },
  { kind: "source_policy", id: contextId("source_policy"), label: "Source policy" },
];

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
  overlay?: RunOverlay,
): StudioGraph {
  const agents = sortedAgents(graph);
  // Per-node run chip only when the anchored run traversed *this* mode's
  // pipeline; a mode mismatch is surfaced by the caller, not per node.
  const runStatusFor = (id: string): NodeRunStatus | undefined =>
    overlay?.modeMatches ? (overlay.byNode[id] ?? { kind: "did-not-run" }) : undefined;
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
    data: { node: n, ownership: ownershipFor(n), runStatus: runStatusFor(n.id) },
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
        id: gateId(g.id),
        type: "gate",
        position: { x: (agents.length + trailing) * X_GAP, y: SPINE_Y },
        data: { label: g.label, description: g.description },
      });
      trailing += 1;
      continue;
    }
    gateNodes.push({
      id: gateId(g.id),
      type: "gate",
      position: { x: anchorIndex * X_GAP, y: GATE_Y },
      data: { label: g.label, description: g.description },
    });
    gateEdges.push({
      id: `gate-edge:${g.id}`,
      source: gateId(g.id),
      sourceHandle: "g-out",
      target: g.before,
      targetHandle: "gate",
      style: { stroke: "var(--color-ink-faint)", strokeDasharray: "3 3" },
    });
  }

  // Partials sit in a row below the spine. Every shared partial the voice
  // owns/inherits is shown as a library node — even one this mode's agents
  // don't currently include (e.g. a voice whose prompt drifted off the shared
  // `{{include}}`). Include-edges below are drawn only to in-graph consumers,
  // so an unwired partial simply renders without edges instead of vanishing.
  const partialNodes: StudioNode[] = partials.map((p, i) => ({
    id: partialId(p.templateId),
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
  const includeEdges: Edge[] = partials.flatMap((p) =>
    p.consumers
      .filter((c) => nodeIds.has(c))
      .map((c) => ({
        id: `inc:${p.templateId}->${c}`,
        source: partialId(p.templateId),
        sourceHandle: "p-out",
        target: c,
        targetHandle: "inc",
        style: { stroke: "var(--color-rule)", strokeDasharray: "2 4" },
      })),
  );

  // Voice-context inputs (locale, source policy) inject into every
  // persona-using agent. Rendered only when there is at least one such agent in
  // this mode — otherwise the inputs would dangle. Dashed neutral edges keep
  // them distinct from the dotted include-edges and the rust loop-back.
  const personaAgents = agents.filter((n) => n.uses_persona);
  const contextNodes: StudioNode[] = [];
  const injectEdges: Edge[] = [];
  if (personaAgents.length > 0) {
    const baseX = (seqIndex.get(personaAgents[0].id) ?? 0) * X_GAP;
    for (const [i, def] of CONTEXT_DEFS.entries()) {
      contextNodes.push({
        id: def.id,
        type: "context",
        position: { x: baseX + i * CONTEXT_X_GAP, y: CONTEXT_Y },
        data: { kind: def.kind, label: def.label, injectCount: personaAgents.length },
      });
      for (const a of personaAgents) {
        injectEdges.push({
          id: `inject:${def.id}->${a.id}`,
          source: def.id,
          sourceHandle: "ctx-out",
          target: a.id,
          targetHandle: "inject",
          style: { stroke: "var(--color-ink-faint)", strokeDasharray: "6 3", opacity: 0.65 },
        });
      }
    }
  }

  return {
    nodes: [...agentNodes, ...gateNodes, ...partialNodes, ...contextNodes],
    edges: [...spineEdges, ...gateEdges, ...includeEdges, ...injectEdges],
  };
}
