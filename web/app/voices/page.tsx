"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { SectionHead } from "@/components/SectionHead";
import { personasApi, promptsApi } from "@/lib/api";

export default function VoicesPage() {
  // TODO Task 13: replace with useState<string | null>(null) when Rolodex wires onSelect
  const [showArchived, setShowArchived] = useState(false);

  const personas = useQuery({
    queryKey: ["personas", showArchived],
    queryFn: () => personasApi.list(showArchived),
  });

  const graph = useQuery({
    queryKey: ["prompt-graph"],
    queryFn: () => promptsApi.graph(),
  });

  // First non-archived persona is auto-selected until Rolodex adds its own state (Task 13).
  const activeSlug = personas.data?.find((p) => !p.is_archived)?.slug ?? null;

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

      {/* Movement 1: Rolodex — replaced in Task 13 */}
      <section aria-label="rolodex" className="border-y border-rule py-6 space-y-3">
        <p className="text-ink-faint text-[12px]">
          Rolodex placeholder · selected: {activeSlug ?? "none"} · click handler comes in Task 13
        </p>
        <label className="text-[12px] text-ink-faint inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          show archived
        </label>
      </section>

      {/* Movement 2: Style Card — replaced in Task 15 */}
      <section aria-label="style-card">
        <p className="text-ink-faint text-[12px]">Style Card placeholder</p>
      </section>

      {/* Movement 3+4: Press Workflow — replaced in Task 16+ */}
      <section aria-label="press-workflow">
        <p className="text-ink-faint text-[12px]">
          Press Workflow placeholder · {graph.data?.nodes.length ?? "?"} nodes loaded
        </p>
      </section>
    </div>
  );
}
