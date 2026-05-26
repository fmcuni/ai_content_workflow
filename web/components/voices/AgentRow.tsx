"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { PromptNode } from "@/lib/types";

interface AgentRowProps {
  index: number;
  node: PromptNode;
  expanded: boolean;
  onToggle: () => void;
  expandable: boolean;
  children?: ReactNode;
}

export function AgentRow({ index, node, expanded, onToggle, expandable, children }: AgentRowProps) {
  const num = String(index).padStart(2, "0");
  return (
    <div className="border-b border-rule">
      <button
        type="button"
        onClick={expandable ? onToggle : undefined}
        className={cn(
          "w-full grid grid-cols-[48px_1fr_24px] gap-6 py-5 items-start text-left",
          expandable && "hover:bg-paper-deep/40 transition-colors",
        )}
      >
        <div className="font-mono text-[14px] text-ink-faint tabular-nums pt-1">{num}</div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <p
              className="font-display text-[24px] text-ink"
              style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
            >
              {node.id}
            </p>
            <span className="font-mono text-[10px] tracking-wider uppercase text-ink-faint">
              {node.kind === "llm" ? "LLM" : "Deterministic"}
            </span>
            {node.uses_persona && (
              <span className="font-mono text-[10px] tracking-wider uppercase text-accent">
                · Persona-bound
              </span>
            )}
          </div>
          <p className="mt-1 text-[14px] text-ink-soft max-w-[65ch]">{node.description}</p>
        </div>
        <div className="font-mono text-[14px] text-ink-faint pt-1 text-right">
          {expandable ? (expanded ? "↑" : "↓") : ""}
        </div>
      </button>
      {expanded && children && (
        <div className="pb-6 pl-[72px] pr-6">{children}</div>
      )}
    </div>
  );
}
