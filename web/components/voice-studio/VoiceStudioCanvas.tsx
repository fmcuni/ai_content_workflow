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

interface VoiceStudioCanvasProps {
  graph: PromptGraph;
  partials: PartialInfo[];
  ownershipById: Record<string, Ownership>;
  onSelect: (nodeId: string | null) => void;
}

function CanvasInner({ graph, partials, ownershipById, onSelect }: VoiceStudioCanvasProps) {
  // Deterministic layout — recomputed whenever the mode (graph), partials, or
  // ownership change. React Flow owns drag + selection from this seed.
  const built = useMemo(
    () => buildStudioGraph(graph, partials, ownershipById),
    [graph, partials, ownershipById],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges);

  // Re-seed on layout change (mode switch). Selection clears with the reset.
  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
    onSelect(null);
    // onSelect is stable from the parent; excluded to avoid a reset loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, setNodes, setEdges]);

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
