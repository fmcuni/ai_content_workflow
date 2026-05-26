"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { promptsApi } from "@/lib/api";
import type { PromptNode } from "@/lib/types";

interface PromptInspectorProps {
  node: PromptNode;
  /** runId picker UI is added in Task 18. */
  userPromptSlot?: React.ReactNode;
}

export function PromptInspector({ node, userPromptSlot }: PromptInspectorProps) {
  const templateIds = [
    node.system_prompt_template_id,
    ...(node.alt_template_ids ?? []),
  ].filter((x): x is string => Boolean(x));

  const [activeId, setActiveId] = useState(templateIds[0] ?? null);

  const tmpl = useQuery({
    enabled: activeId !== null,
    queryKey: ["prompt-template", activeId],
    queryFn: () => promptsApi.template(activeId!),
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-6 mt-2">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <p className="kicker">System prompt</p>
          {templateIds.length > 1 && (
            <div className="flex gap-1">
              {templateIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveId(id)}
                  className={`font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 border ${
                    id === activeId ? "border-accent text-accent" : "border-rule text-ink-faint"
                  }`}
                >
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
        {tmpl.isLoading && <p className="text-ink-faint text-[12px]">Loading…</p>}
        {tmpl.data && (
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-soft border border-rule p-3 max-h-[480px] overflow-auto">
            {tmpl.data.template.replace(
              "{persona_block}",
              "[ persona block — see Style Card above ]",
            )}
          </pre>
        )}
      </div>
      <div>
        <p className="kicker mb-2">User prompt</p>
        {userPromptSlot ?? (
          <p className="text-ink-faint text-[12px]">User prompt picker coming next.</p>
        )}
      </div>
    </div>
  );
}
