"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { cn } from "@/lib/utils";
import type {
  AgentNodeData,
  ContextNodeData,
  GateNodeData,
  Ownership,
  PartialNodeData,
} from "./layout";

// Fixed card width keeps the deterministic layout stable when labels vary.
const CARD_W = 220;

function OwnershipChip({ ownership, templateId }: { ownership: Ownership; templateId: string }) {
  if (ownership === "none") {
    return (
      <span className="font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
        no prompt
      </span>
    );
  }
  return (
    <span
      className="font-mono text-[9.5px] truncate"
      title={
        ownership === "overridden"
          ? `${templateId} — this voice has its own copy`
          : `${templateId} — inherits the shared default`
      }
    >
      <span className="text-ink-soft">{templateId}</span>
      <span
        className={cn(
          "ml-1 uppercase tracking-wider",
          ownership === "overridden" ? "text-accent" : "text-ink-faint",
        )}
      >
        · {ownership === "overridden" ? "voice" : "shared"}
      </span>
    </span>
  );
}

export function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData, "agent">>) {
  const { node, ownership } = data;
  const isLlm = node.kind === "llm";
  const templateId = node.system_prompt_template_id;
  return (
    <div
      style={{ width: CARD_W }}
      className={cn(
        "bg-paper border rounded-sm px-3 py-2.5 shadow-sm transition-colors",
        selected ? "border-accent ring-1 ring-accent" : "border-rule hover:border-ink-faint",
      )}
    >
      <Handle id="in" type="target" position={Position.Left} className="!bg-ink-faint" />
      <Handle id="out" type="source" position={Position.Right} className="!bg-ink-faint" />
      <Handle id="gate" type="target" position={Position.Top} className="!bg-transparent !border-0" />
      <Handle
        id="inject"
        type="target"
        position={Position.Top}
        style={{ left: "28%" }}
        className="!bg-transparent !border-0"
      />
      <Handle id="inc" type="target" position={Position.Bottom} className="!bg-transparent !border-0" />

      <div className="flex items-center justify-between gap-2 mb-1">
        <span
          className={cn(
            "font-mono text-[9px] uppercase tracking-[0.14em] px-1 py-px rounded-sm",
            isLlm ? "bg-ink text-paper" : "bg-paper-deep/60 text-ink-faint border border-rule",
          )}
        >
          {isLlm ? "LLM" : "deterministic"}
        </span>
        {node.uses_persona && (
          <span
            className="font-mono text-[9px] uppercase tracking-wider text-accent"
            title="Persona / voice tokens injected into this prompt"
          >
            ◆ persona
          </span>
        )}
      </div>

      <p className="font-display text-[14px] leading-tight text-ink truncate" title={node.id}>
        {node.id}
      </p>
      {node.description && (
        <p className="text-[11px] text-ink-soft leading-snug mt-0.5 line-clamp-2">
          {node.description}
        </p>
      )}
      <div className="mt-1.5 truncate">
        <OwnershipChip ownership={ownership} templateId={templateId ?? node.id} />
      </div>
    </div>
  );
}

export function PartialNode({ data, selected }: NodeProps<Node<PartialNodeData, "partial">>) {
  const { templateId, consumerCount, ownership } = data;
  return (
    <div
      style={{ width: 200 }}
      className={cn(
        "bg-paper-deep/40 border border-dashed rounded-sm px-3 py-2 transition-colors",
        selected ? "border-accent ring-1 ring-accent" : "border-rule hover:border-ink-faint",
      )}
    >
      <Handle id="p-out" type="source" position={Position.Top} className="!bg-rule" />
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint border border-rule rounded-sm px-1 py-px">
          partial
        </span>
        {ownership === "overridden" && (
          <span className="font-mono text-[9px] uppercase tracking-wider text-accent">voice</span>
        )}
      </div>
      <p className="font-mono text-[12px] text-ink truncate" title={templateId}>
        {templateId}
      </p>
      <p className="font-mono text-[10px] text-ink-faint mt-0.5">
        included by {consumerCount} {consumerCount === 1 ? "agent" : "agents"}
      </p>
    </div>
  );
}

export function GateNode({ data, selected }: NodeProps<Node<GateNodeData, "gate">>) {
  return (
    <div
      style={{ width: 180 }}
      className={cn(
        "border-2 rounded-sm px-3 py-1.5 text-center bg-paper transition-colors",
        selected ? "border-accent ring-1 ring-accent" : "border-ink",
      )}
      title={data.description}
    >
      <Handle id="g-out" type="source" position={Position.Bottom} className="!bg-ink" />
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink">{data.label}</p>
      <p className="font-mono text-[9px] uppercase tracking-wider text-ink-faint mt-0.5">
        human review
      </p>
    </div>
  );
}

export function ContextNode({ data, selected }: NodeProps<Node<ContextNodeData, "context">>) {
  const { label, injectCount } = data;
  return (
    <div
      style={{ width: 168 }}
      className={cn(
        "bg-paper border rounded-sm px-3 py-2 transition-colors",
        selected ? "border-accent ring-1 ring-accent" : "border-rule hover:border-ink-faint",
      )}
      title={`Voice ${label.toLowerCase()} — injected into ${injectCount} persona-using ${
        injectCount === 1 ? "agent" : "agents"
      }`}
    >
      <Handle id="ctx-out" type="source" position={Position.Bottom} className="!bg-ink-faint" />
      <div className="flex items-center gap-1.5 mb-0.5">
        <span aria-hidden className="text-ink-faint text-[11px]">
          ⬡
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
          voice context
        </span>
      </div>
      <p className="font-display text-[14px] leading-tight text-ink">{label}</p>
      <p className="font-mono text-[10px] text-ink-faint mt-0.5">
        injects → {injectCount} {injectCount === 1 ? "agent" : "agents"}
      </p>
    </div>
  );
}

export const STUDIO_NODE_TYPES = {
  agent: AgentNode,
  partial: PartialNode,
  gate: GateNode,
  context: ContextNode,
};
