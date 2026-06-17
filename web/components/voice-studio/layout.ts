import type { Edge, Node } from "@xyflow/react";

import type { PromptGate, PromptGraph, PromptNode } from "@/lib/types";
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
// Gates render inline on the spine as boxes. They are shorter than the agent
// cards, so nudge them down so the gate's vertical centre lines up with the
// card's — this keeps the predecessor → gate → node connectors dead straight.
const GATE_Y = 34;
// Partials hang well below the spine so they clear the loop-back lane (backward
// edges bow under the cards just beneath the spine).
const PARTIAL_Y = 300;
const PARTIAL_X_GAP = 260;
// Voice-context inputs sit above the spine and inject down into the agents that
// consume them. The gate band is gone (gates are inline now), so this sits
// closer to the spine to keep the vertical spread compact. The two context
// boxes stack on separate rows (CONTEXT_ROW_H apart) so they never collide even
// when their target spans overlap.
const CONTEXT_Y = -200;
const CONTEXT_ROW_H = 120;
// Which agents each context injects into. Locale tokens (brand / language /
// market) are substituted into EVERY LLM prompt — including gap_analysis and
// outline, which don't use the persona block — whereas the source-policy block
// only lands in the persona/citation agents (writer, audit).
const CONTEXT_DEFS: {
  kind: ContextKind;
  id: string;
  label: string;
  appliesTo: (n: PromptNode) => boolean;
}[] = [
  { kind: "locale", id: contextId("locale"), label: "Locale", appliesTo: (n) => n.kind === "llm" },
  {
    kind: "source_policy",
    id: contextId("source_policy"),
    label: "Source policy",
    appliesTo: (n) => n.uses_persona,
  },
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

  // A partial's consumers come from the API as *template ids* (the agent prompt
  // that {{include}}s it), which differ from node ids (node "writer" runs
  // template "writer_small_refresh"). Map each agent's system + alt templates
  // back to its node id so include-edges resolve to a node that exists on the
  // canvas instead of dangling against a non-existent template-id target.
  const templateToNode = new Map<string, string>();
  for (const n of agents) {
    if (n.system_prompt_template_id) templateToNode.set(n.system_prompt_template_id, n.id);
    for (const alt of n.alt_template_ids ?? []) templateToNode.set(alt, n.id);
  }
  // Distinct in-graph node ids that consume each partial (index-aligned to
  // `partials`). A node appears once even if both its system + alt templates
  // include the partial.
  const partialConsumers: string[][] = partials.map((p) => {
    const ids = new Set<string>();
    for (const c of p.consumers) {
      const nid = templateToNode.get(c);
      if (nid !== undefined) ids.add(nid);
    }
    return [...ids];
  });

  // Gates render inline on the spine as boxes. A node-anchored gate (HITL_1
  // before writer, HITL_2 before publish) takes its own column immediately
  // before the node it guards; an "__end__" gate (HITL_T1) trails the last
  // agent. Downstream agents shift right to make room.
  const gatesByAnchor = new Map<string, PromptGate[]>();
  const trailingGates: PromptGate[] = [];
  for (const g of graph.gates) {
    if (seqIndex.has(g.before)) {
      const arr = gatesByAnchor.get(g.before) ?? [];
      arr.push(g);
      gatesByAnchor.set(g.before, arr);
    } else {
      trailingGates.push(g);
    }
  }

  // Combined left→right column order: each gate that guards a node, then the
  // node; trailing gates last. Gives every spine item a stable x.
  const columnX = new Map<string, number>();
  let col = 0;
  for (const n of agents) {
    for (const g of gatesByAnchor.get(n.id) ?? []) {
      columnX.set(gateId(g.id), col * X_GAP);
      col += 1;
    }
    columnX.set(n.id, col * X_GAP);
    col += 1;
  }
  for (const g of trailingGates) {
    columnX.set(gateId(g.id), col * X_GAP);
    col += 1;
  }

  const agentNodes: StudioNode[] = agents.map((n) => ({
    id: n.id,
    type: "agent",
    position: { x: columnX.get(n.id) ?? 0, y: SPINE_Y },
    data: { node: n, ownership: ownershipFor(n), runStatus: runStatusFor(n.id) },
  }));

  // Gate boxes sit inline on the spine; solid edges flow predecessor → gate →
  // guarded node so the gate reads as a station in the pipeline. Chained gates
  // (multiple before one node) hand off to each other before the node.
  const gateNodes: StudioNode[] = [];
  const gateEdges: Edge[] = [];
  for (const [anchorId, gates] of gatesByAnchor) {
    gates.forEach((g, i) => {
      gateNodes.push({
        id: gateId(g.id),
        type: "gate",
        position: { x: columnX.get(gateId(g.id)) ?? 0, y: GATE_Y },
        data: { label: g.label, description: g.description },
      });
      const next = i + 1 < gates.length ? gateId(gates[i + 1].id) : anchorId;
      gateEdges.push({
        id: `gate-out:${g.id}`,
        source: gateId(g.id),
        sourceHandle: "g-out",
        target: next,
        targetHandle: "in",
        type: "smoothstep",
        style: { stroke: "var(--color-ink-soft)" },
      });
    });
  }
  // Trailing gate: draw an edge from the last agent so it stays wired into the
  // flow rather than floating after the spine.
  const lastAgent = agents[agents.length - 1];
  for (const g of trailingGates) {
    gateNodes.push({
      id: gateId(g.id),
      type: "gate",
      position: { x: columnX.get(gateId(g.id)) ?? 0, y: GATE_Y },
      data: { label: g.label, description: g.description },
    });
    if (lastAgent) {
      gateEdges.push({
        id: `gate-in:${g.id}`,
        source: lastAgent.id,
        sourceHandle: "out",
        target: gateId(g.id),
        targetHandle: "in",
        type: "smoothstep",
        style: { stroke: "var(--color-ink-soft)" },
      });
    }
  }

  // Partials render only where article-writing prompts can include them. The
  // topic-expansion pipeline has no such includes, so the library row is hidden
  // there entirely rather than shown as a shelf of "not included here".
  const showPartials = graph.mode !== "topic_expansion";

  // Each consumed partial sits in a vertical stack directly under the agent
  // that includes it, so its dotted include-edge is a short near-vertical line
  // instead of a long diagonal across the spine. Partials with no in-graph
  // consumer shelf to a left-packed row below the connected stacks. Stacks are
  // one-per-spine-column (X_GAP apart) and partials are narrower than a column,
  // so the boxes never overlap. The row pitch must exceed the partial card
  // height (~76px) or stacked cards collide — keep it comfortably larger.
  const PARTIAL_STACK_H = 96;
  const PARTIAL_W = 200;
  const AGENT_W = 220;
  const consumedGroups = new Map<string, number[]>();
  const unconsumed: number[] = [];
  partials.forEach((_p, i) => {
    const primary = partialConsumers[i][0];
    if (primary !== undefined) {
      consumedGroups.set(primary, [...(consumedGroups.get(primary) ?? []), i]);
    } else {
      unconsumed.push(i);
    }
  });

  const partialNodes: StudioNode[] = [];
  if (showPartials) {
    const partialNodeFor = (i: number, x: number, y: number): StudioNode => ({
      id: partialId(partials[i].templateId),
      type: "partial",
      position: { x, y },
      data: {
        templateId: partials[i].templateId,
        consumerCount: partialConsumers[i].length,
        ownership: partials[i].ownership,
      },
    });
    for (const [nodeId, idxs] of consumedGroups) {
      const cx = (columnX.get(nodeId) ?? 0) + (AGENT_W - PARTIAL_W) / 2;
      idxs.forEach((i, k) => partialNodes.push(partialNodeFor(i, cx, PARTIAL_Y + k * PARTIAL_STACK_H)));
    }
    const tallestStack = Math.max(0, ...[...consumedGroups.values()].map((a) => a.length));
    const shelfY = PARTIAL_Y + tallestStack * PARTIAL_STACK_H + 28;
    unconsumed.forEach((i, k) => partialNodes.push(partialNodeFor(i, k * PARTIAL_X_GAP, shelfY)));
  }

  // Spine edges from the graph topology. A target earlier in the sequence than
  // its source is a loop-back (audit → writer refine loop, or a gate
  // "request changes" jump) — these can span the whole production run, so route
  // them through the agents' BOTTOM handles. smoothstep then bows the edge down
  // into a lane just under the cards and back up, instead of cutting a straight
  // rust line across every node in between. Forward edges stay on the left/right
  // handles at spine level; a gated target routes into the gate box first, with
  // the gate → node continuation drawn separately.
  const spineEdges: Edge[] = graph.edges
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => {
      const si = seqIndex.get(e.from)!;
      const ti = seqIndex.get(e.to)!;
      const isLoopBack = ti <= si;
      if (isLoopBack) {
        return {
          id: `spine:${e.from}->${e.to}`,
          source: e.from,
          sourceHandle: "loop-out",
          target: e.to,
          targetHandle: "loop-in",
          type: "smoothstep",
          label: e.label ?? "refine loop",
          animated: true,
          style: { stroke: "var(--color-accent)", strokeWidth: 1.5 },
          labelStyle: { fill: "var(--color-accent)", fontFamily: "var(--font-mono)", fontSize: 10 },
          labelBgStyle: { fill: "var(--color-paper)" },
        };
      }
      const gate = gatesByAnchor.get(e.to)?.[0];
      return {
        id: `spine:${e.from}->${e.to}`,
        source: e.from,
        sourceHandle: "out",
        target: gate ? gateId(gate.id) : e.to,
        targetHandle: "in",
        type: "smoothstep",
        label: e.label,
        animated: false,
        style: { stroke: "var(--color-ink-soft)" },
        labelStyle: { fill: "var(--color-ink-faint)", fontFamily: "var(--font-mono)", fontSize: 10 },
        labelBgStyle: { fill: "var(--color-paper)" },
      };
    });

  // Dotted hairline include-edges: partial → each consuming agent node in this
  // mode (resolved from template ids via `partialConsumers`). Suppressed
  // alongside the partial nodes in topic-expansion mode.
  const includeEdges: Edge[] = showPartials
    ? partials.flatMap((p, i) =>
        partialConsumers[i].map((nid) => ({
          id: `inc:${p.templateId}->${nid}`,
          source: partialId(p.templateId),
          sourceHandle: "p-out",
          target: nid,
          targetHandle: "inc",
          // Orthogonal routing: a clean vertical drop up into the consumer
          // rather than a diagonal that crosses neighbouring cards.
          type: "smoothstep",
          style: { stroke: "var(--color-rule)", strokeDasharray: "2 4" },
        })),
      )
    : [];

  // Voice-context inputs inject into the agents that consume them (see
  // CONTEXT_DEFS). Each box is centred above the span of its targets and the
  // two boxes stack on separate rows, so they never collide. Dashed neutral
  // edges keep them distinct from the dotted include-edges and the rust
  // loop-back. A context with no target in this mode is dropped (no dangle).
  const contextNodes: StudioNode[] = [];
  const injectEdges: Edge[] = [];
  CONTEXT_DEFS.forEach((def, i) => {
    const targets = agents.filter(def.appliesTo);
    if (targets.length === 0) return;
    const xs = targets.map((t) => columnX.get(t.id) ?? 0);
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    contextNodes.push({
      id: def.id,
      type: "context",
      position: { x: centerX, y: CONTEXT_Y - i * CONTEXT_ROW_H },
      data: { kind: def.kind, label: def.label, injectCount: targets.length },
    });
    for (const a of targets) {
      injectEdges.push({
        id: `inject:${def.id}->${a.id}`,
        source: def.id,
        sourceHandle: "ctx-out",
        target: a.id,
        targetHandle: "inject",
        // Orthogonal routing turns the one-to-many fan into a clean bus (drop →
        // run → drop) instead of long diagonals spraying across the spine.
        type: "smoothstep",
        style: { stroke: "var(--color-ink-faint)", strokeDasharray: "6 3", opacity: 0.5 },
      });
    }
  });

  return {
    nodes: [...agentNodes, ...gateNodes, ...partialNodes, ...contextNodes],
    edges: [...spineEdges, ...gateEdges, ...includeEdges, ...injectEdges],
  };
}
