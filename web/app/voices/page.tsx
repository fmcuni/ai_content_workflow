"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { SectionHead } from "@/components/SectionHead";
import { ComposeDrawer } from "@/components/voices/ComposeDrawer";
import { Rolodex } from "@/components/voices/Rolodex";
import { StyleCard } from "@/components/voices/StyleCard";
import { PressWorkflow } from "@/components/voices/PressWorkflow";
import { PromptInspector } from "@/components/voices/PromptInspector";
import { personasApi, promptsApi } from "@/lib/api";
import type { GraphMode } from "@/lib/types";

export default function VoicesPage() {
  const [showArchived, setShowArchived] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [graphMode, setGraphMode] = useState<GraphMode>("refresh");
  const [composeMode, setComposeMode] = useState<
    | null
    | { kind: "create" }
    | { kind: "edit"; slug: string }
  >(null);

  const personas = useQuery({
    queryKey: ["personas", showArchived],
    queryFn: () => personasApi.list(showArchived),
  });

  const graph = useQuery({
    queryKey: ["prompt-graph", graphMode],
    queryFn: () => promptsApi.graph(graphMode),
  });

  const activeSlug = selectedSlug
    ?? personas.data?.find((p) => !p.is_archived)?.slug
    ?? null;

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 space-y-12">
      <SectionHead
        kicker="Style Sheet · Voices"
        hed="House Voices"
        dek="The personas that shape the desk's copy — and the route each story walks before press."
      />

      {personas.isLoading && <p className="text-ink-faint">Loading voices…</p>}
      {personas.isError && (
        <p className="text-accent-deep text-[13px]">Failed to load voices.</p>
      )}

      {/* Movement 1: Rolodex */}
      <section aria-label="rolodex" className="border-y border-rule py-6 space-y-3">
        {personas.data && (
          <Rolodex
            personas={personas.data}
            selectedSlug={activeSlug}
            onSelect={setSelectedSlug}
            onNewVoice={() => setComposeMode({ kind: "create" })}
          />
        )}
        <label className="text-[12px] text-ink-faint inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          show archived
        </label>
      </section>

      {/* Movement 2: Style Card */}
      <section aria-label="style-card">
        {personas.data && activeSlug && (() => {
          const selected = personas.data.find((p) => p.slug === activeSlug);
          if (!selected) return null;
          return (
            <StyleCard
              persona={selected}
              onEdit={() => setComposeMode({ kind: "edit", slug: selected.slug })}
            />
          );
        })()}
      </section>

      {/* Movement 3+4: Press Workflow */}
      <section aria-label="press-workflow">
        {graph.data && (
          <PressWorkflow
            graph={graph.data}
            mode={graphMode}
            onModeChange={setGraphMode}
            renderInspector={(node) => <PromptInspector node={node} mode={graphMode} />}
          />
        )}
      </section>

      {composeMode && personas.data && (
        <ComposeDrawer
          mode={
            composeMode.kind === "create"
              ? { kind: "create" }
              : (() => {
                  const found = personas.data.find((p) => p.slug === composeMode.slug);
                  if (!found) return { kind: "create" } as const;
                  return { kind: "edit", persona: found } as const;
                })()
          }
          onClose={() => setComposeMode(null)}
          onSaved={(slug) => {
            setComposeMode(null);
            setSelectedSlug(slug);
          }}
        />
      )}
    </div>
  );
}
