"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";

import "@xyflow/react/dist/style.css";

import type { PromptGraph } from "@/lib/types";
import { buildStudioGraph, type Ownership, type PartialInfo } from "./layout";
import { STUDIO_NODE_TYPES } from "./nodes";
import type { RunOverlay } from "./run-overlay";

interface VoiceStudioCanvasProps {
  graph: PromptGraph;
  partials: PartialInfo[];
  ownershipById: Record<string, Ownership>;
  /** Per-node execution overlay from the anchored run (PR3). Undefined = no chips. */
  overlay?: RunOverlay;
  onSelect: (nodeId: string | null) => void;
}

function CanvasInner({ graph, partials, ownershipById, overlay, onSelect }: VoiceStudioCanvasProps) {
  // Deterministic layout — recomputed whenever the mode (graph), partials,
  // ownership, or the anchored-run overlay change. React Flow owns drag +
  // selection from this seed.
  const built = useMemo(
    () => buildStudioGraph(graph, partials, ownershipById, overlay),
    [graph, partials, ownershipById, overlay],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges);

  // `built` recomputes on every render (its `partials` input is fed by
  // useQueries, which returns a fresh array each render). Re-seed only when the
  // layout *content* actually changes — keyed off a stable string signature, so
  // node positions aren't snapped back every render and clicks aren't dropped.
  const signature = useMemo(
    () =>
      JSON.stringify({
        n: built.nodes.map((n) => [n.id, n.type, n.position.x, n.position.y, n.data]),
        e: built.edges.map((e) => e.id),
      }),
    [built],
  );
  // Selection is owned by the parent and cleared there on mode change; the
  // canvas must NOT reset it here, or the re-seed would wipe every click.
  // `built` is keyed by `signature`: it changes identity every render, but the
  // effect only fires when the content signature changes, at which point the
  // closed-over `built` is the current render's value.
  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, setNodes, setEdges]);

  const handleNodeClick: NodeMouseHandler<Node> = (_e, node) => onSelect(node.id);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={STUDIO_NODE_TYPES}
      onNodeClick={handleNodeClick}
      onPaneClick={() => onSelect(null)}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.3}
      maxZoom={1.5}
      nodesConnectable={false}
      proOptions={{ hideAttribution: false }}
      className="bg-paper"
    >
      <Background variant={BackgroundVariant.Lines} gap={28} color="var(--color-rule)" />
      <MiniMap
        pannable
        zoomable
        nodeColor="var(--color-rule)"
        maskColor="rgba(26,23,20,0.06)"
        className="!bg-paper-deep/40 !border !border-rule"
      />
      <Controls showInteractive={false} className="!border !border-rule" />
    </ReactFlow>
  );
}

/**
 * Editorial React Flow canvas for one voice's prompt pipeline (one mode).
 * Read-only topology — clicking a node bubbles its id to the parent, which
 * opens the polymorphic inspector. The graph-paper background + hairline edges
 * give it the differentiated "schematic" feel from the spec.
 */
export function VoiceStudioCanvas(props: VoiceStudioCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
