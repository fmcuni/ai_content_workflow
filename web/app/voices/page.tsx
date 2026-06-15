"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { SectionHead } from "@/components/SectionHead";
import { ComposeDrawer } from "@/components/voices/ComposeDrawer";
import { DuplicateVoiceDialog } from "@/components/voices/DuplicateVoiceDialog";
import { Rolodex } from "@/components/voices/Rolodex";
import { StyleCard } from "@/components/voices/StyleCard";
import { PressWorkflow } from "@/components/voices/PressWorkflow";
import { PromptInspector } from "@/components/voices/PromptInspector";
import { personasApi, promptsApi } from "@/lib/api";
import type { GraphMode, VoiceLocale } from "@/lib/types";
import { useRole } from "@/lib/use-role";

export default function VoicesPage() {
  // Creating/editing/archiving personas is admin-only (server-authoritative).
  const { can } = useRole();
  const canManage = can("manage_personas");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [graphMode, setGraphMode] = useState<GraphMode>("refresh");
  // New voices are created by DUPLICATING an existing one; ComposeDrawer is now
  // edit-only. The two flows are distinct dialogs.
  const [composeMode, setComposeMode] = useState<
    | null
    | { kind: "duplicate" }
    | { kind: "edit"; slug: string }
  >(null);
  // In-progress (unsaved) locale from the open edit drawer, fed to the live
  // PromptInspector preview. Cleared whenever the edit drawer is dismissed.
  const [liveLocale, setLiveLocale] = useState<VoiceLocale | null>(null);

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
            canManage={canManage}
            onNewVoice={() => setComposeMode({ kind: "duplicate" })}
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
              canManage={canManage}
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
            renderInspector={(node) => (
              <PromptInspector
                node={node}
                mode={graphMode}
                voice={activeSlug ?? "bowtie-editor"}
                liveLocale={
                  composeMode?.kind === "edit" && composeMode.slug === activeSlug
                    ? (liveLocale ?? undefined)
                    : undefined
                }
              />
            )}
          />
        )}
      </section>

      {composeMode?.kind === "duplicate" && personas.data && canManage && (
        <DuplicateVoiceDialog
          candidates={personas.data.filter((p) => !p.is_archived)}
          defaultSourceSlug={activeSlug ?? undefined}
          onClose={() => setComposeMode(null)}
          onDuplicated={(slug) => {
            setComposeMode(null);
            setSelectedSlug(slug);
          }}
        />
      )}

      {composeMode?.kind === "edit" && personas.data && canManage && (() => {
        const found = personas.data.find((p) => p.slug === composeMode.slug);
        if (!found) return null;
        // The app must always keep one usable voice — block archiving the last
        // non-archived one (the server returns 409 either way).
        const activeCount = personas.data.filter((p) => !p.is_archived).length;
        const isLastVoice = !found.is_archived && activeCount <= 1;
        return (
          <ComposeDrawer
            mode={{ kind: "edit", persona: found }}
            isLastVoice={isLastVoice}
            canManage={canManage}
            onLocaleChange={setLiveLocale}
            onClose={() => {
              setComposeMode(null);
              setLiveLocale(null);
            }}
            onSaved={(slug) => {
              setComposeMode(null);
              setLiveLocale(null);
              setSelectedSlug(slug);
            }}
          />
        );
      })()}
    </div>
  );
}
