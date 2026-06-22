"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Suspense, use, useMemo, useState } from "react";
import { toast } from "sonner";

import { VoiceStudioCanvas } from "@/components/voice-studio/VoiceStudioCanvas";
import {
  StudioInspector,
  type StudioSelection,
} from "@/components/voice-studio/StudioInspector";
import type { Ownership, PartialInfo } from "@/components/voice-studio/layout";
import { classifyNodeId, VOICE_SETTINGS_ID } from "@/components/voice-studio/node-id";
import {
  buildRunOverlay,
  graphModeForRun,
  type RunOverlay,
} from "@/components/voice-studio/run-overlay";
import { StudioDraftProvider, useStudioDraft } from "@/lib/voice-studio/draft-store-provider";
import { useSaveAll, type SaveAllResult } from "@/lib/voice-studio/use-save-all";
import { useUnsavedGuard } from "@/lib/voice-studio/use-unsaved-guard";
import { api, promptsApi } from "@/lib/api";
import type { GraphMode, RunSummary } from "@/lib/types";
import { partialId } from "@/components/voice-studio/node-id";
import { cn } from "@/lib/utils";

const MODES: { mode: GraphMode; label: string }[] = [
  { mode: "refresh", label: "Rewrite" },
  { mode: "create", label: "Create" },
  { mode: "topic_expansion", label: "Expand Topics" },
];

// Run statuses that have progressed far enough to carry sampleable agent
// inputs — preferred when defaulting the run anchor.
const PROGRESSED = new Set([
  "published",
  "persisted",
  "hitl_2",
  "revising",
  "production",
  "publishing",
]);

/** Most recent progressed run for this voice (any run if none progressed). */
function pickDefaultRun(runs: RunSummary[] | undefined, slug: string): string | null {
  if (!runs) return null;
  const mine = runs
    .filter((r) => r.persona === slug)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (mine.length === 0) return null;
  const progressed = mine.find((r) => PROGRESSED.has(r.status));
  return (progressed ?? mine[0]).run_id;
}

export default function VoiceStudioPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return (
    <Suspense fallback={null}>
      <VoiceStudioContent params={params} />
    </Suspense>
  );
}

function VoiceStudioContent({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  // The draft store wraps the whole shell (header toolbar + canvas + inspector)
  // so the unsaved indicator, Save-all, and loss guard can read it. Per-voice:
  // `key={slug}` remounts the provider on a voice switch, so its useReducer resets
  // to initial state naturally — no render-phase reset needed.
  return (
    <StudioDraftProvider key={slug} voice={slug}>
      <VoiceStudioInner slug={slug} />
    </StudioDraftProvider>
  );
}

function VoiceStudioInner({ slug }: { slug: string }) {
  const [mode, setMode] = useState<GraphMode>("refresh");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The run anchor: defaults to the latest progressed run for this voice until
  // the operator picks one explicitly.
  const [pickedRun, setPickedRun] = useState<string | null>(null);

  const graphQ = useQuery({
    queryKey: ["prompts", "graph", mode],
    queryFn: () => promptsApi.graph(mode),
  });
  const templatesQ = useQuery({
    queryKey: ["prompts", "templates", slug],
    queryFn: () => promptsApi.listTemplates(slug),
  });
  const runsQ = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns() });

  // Per-template ownership: the voice's own row vs the inherited shared seed.
  const ownershipById = useMemo<Record<string, Ownership>>(() => {
    const map: Record<string, Ownership> = {};
    for (const t of templatesQ.data?.templates ?? []) {
      map[t.template_id] = t.voice_slug === slug ? "overridden" : "shared";
    }
    for (const j of templatesQ.data?.judges ?? []) {
      map[j.template_id] = "shared";
    }
    return map;
  }, [templatesQ.data, slug]);

  const partialItems = useMemo(
    () => (templatesQ.data?.templates ?? []).filter((t) => t.category === "partial"),
    [templatesQ.data],
  );

  // Reverse the include-map: consumers per partial (one query each — there are
  // only a handful of partials).
  const consumerQs = useQueries({
    queries: partialItems.map((p) => ({
      queryKey: ["prompts", "consumers", slug, p.template_id],
      queryFn: () => promptsApi.templateConsumers(p.template_id, slug),
    })),
  });

  const partials = useMemo<PartialInfo[]>(
    () =>
      partialItems.map((p, i) => ({
        templateId: p.template_id,
        consumers: consumerQs[i]?.data?.consumers ?? [],
        ownership: ownershipById[p.template_id] ?? "shared",
      })),
    [partialItems, consumerQs, ownershipById],
  );

  const runId = pickedRun ?? pickDefaultRun(runsQ.data, slug);
  const voiceRuns = useMemo(
    () =>
      (runsQ.data ?? [])
        .filter((r) => r.persona === slug)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [runsQ.data, slug],
  );

  // Run-chip execution overlay (PR3): pull the anchored run's event log and
  // derive a per-node "ran / did-not-run / ×N" summary. Read-only reuse of the
  // existing /runs/{id}/logs endpoint — no telemetry rebuild.
  const anchoredRun = useMemo(
    () => voiceRuns.find((r) => r.run_id === runId) ?? null,
    [voiceRuns, runId],
  );
  const logsQ = useQuery({
    enabled: runId !== null,
    queryKey: ["run-logs", runId],
    queryFn: () => api.getRunLogs(runId!),
    retry: false,
  });
  const overlay = useMemo<RunOverlay | undefined>(() => {
    if (!anchoredRun || !logsQ.data) return undefined;
    return buildRunOverlay(logsQ.data, anchoredRun, mode);
  }, [anchoredRun, logsQ.data, mode]);

  // Resolve the clicked canvas node id into a typed inspector selection.
  const selection = useMemo<StudioSelection | null>(() => {
    if (!selectedId) return null;
    const c = classifyNodeId(selectedId);
    switch (c.kind) {
      // Voice-config + partial selections don't depend on the graph.
      case "voice-settings":
        return { kind: "voice-config", tab: "locale" };
      case "context":
        return { kind: "voice-config", tab: c.tab };
      case "partial":
        return { kind: "partial", templateId: c.templateId };
      case "gate": {
        if (!graphQ.data) return null;
        const gate = graphQ.data.gates.find((g) => g.id === c.id);
        return gate
          ? { kind: "gate", label: gate.label, description: gate.description }
          : null;
      }
      case "agent": {
        if (!graphQ.data) return null;
        const node = graphQ.data.nodes.find((n) => n.id === c.id);
        return node ? { kind: "agent", node } : null;
      }
    }
  }, [selectedId, graphQ.data]);

  // ---- Unsaved drafts: count, Save-all, loss guard -----------------------
  const studio = useStudioDraft();
  const unsavedCount = studio?.unsavedCount ?? 0;
  const { saveAll, isSaving } = useSaveAll(slug);
  useUnsavedGuard(unsavedCount);

  // Optional single batch note stamped on each prompt/partial history row in the
  // commit (config writes ignore it).
  const [batchNote, setBatchNote] = useState("");
  const [showDiscard, setShowDiscard] = useState(false);

  // Jump the canvas selection to the node owning a template — used to surface
  // the first pre-validation offender. Partials map to their partial node; an
  // agent prompt maps to the agent node referencing it.
  const selectTemplateNode = (templateId: string) => {
    const isPartial = partialItems.some((p) => p.template_id === templateId);
    if (isPartial) {
      setSelectedId(partialId(templateId));
      return;
    }
    const owner = (graphQ.data?.nodes ?? []).find(
      (n) =>
        n.system_prompt_template_id === templateId ||
        (n.alt_template_ids ?? []).includes(templateId),
    );
    if (owner) setSelectedId(owner.id);
  };

  const reportSaveAll = (result: SaveAllResult) => {
    if (result.validationErrors.length > 0) {
      const first = result.validationErrors[0];
      selectTemplateNode(first.templateId);
      const reason = first.tooLarge
        ? "exceeds 64 KiB"
        : `missing ${first.missingPlaceholders.map((p) => `{${p}}`).join(", ")}`;
      toast.error(
        `Can't save — ${first.templateId} ${reason}` +
          (result.validationErrors.length > 1
            ? ` (+${result.validationErrors.length - 1} more)`
            : ""),
      );
      return;
    }
    const conflicts = result.items.filter((i) => !i.ok && i.conflict).length;
    const failures = result.items.filter((i) => !i.ok && !i.conflict).length;
    const parts = [`Saved ${result.ok} of ${result.total}`];
    if (conflicts > 0) parts.push(`${conflicts} conflict${conflicts > 1 ? "s" : ""}`);
    if (failures > 0) parts.push(`${failures} failed`);
    const message = parts.join(" · ");
    if (result.ok === result.total) {
      toast.success(message);
      setBatchNote("");
    } else if (conflicts > 0) {
      toast.error(`${message} — reload the conflicted item(s) to merge.`);
    } else {
      toast.error(message);
    }
  };

  const handleSaveAll = async () => {
    if (unsavedCount === 0 || isSaving) return;
    reportSaveAll(await saveAll(batchNote));
  };

  const handleDiscardAll = () => {
    studio?.clearAll();
    setBatchNote("");
    setShowDiscard(false);
  };

  return (
    <div className="flex h-[calc(100vh-var(--app-header-h,56px))] flex-col">
      <header className="px-5 md:px-8 py-4 border-b border-rule">
        <Link
          href="/voices"
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint hover:text-accent inline-block mb-2"
        >
          ← Voices
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="kicker">Voice Studio</p>
            <h1 className="font-display text-[26px] leading-none text-ink">{slug}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <div className="inline-flex border border-rule divide-x divide-rule">
              {MODES.map((m) => (
                <button
                  key={m.mode}
                  type="button"
                  aria-pressed={m.mode === mode}
                  onClick={() => {
                    setMode(m.mode);
                    setSelectedId(null);
                  }}
                  className={cn(
                    "font-mono text-[11px] tracking-[0.16em] uppercase px-3 py-1.5 transition-colors",
                    m.mode === mode
                      ? "bg-ink text-paper"
                      : "text-ink-faint hover:bg-paper-deep/40 hover:text-ink",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                Run
              </span>
              <select
                value={runId ?? ""}
                onChange={(e) => setPickedRun(e.target.value || null)}
                className="font-mono text-[11px] text-ink bg-paper border border-rule rounded-sm px-2 py-1 max-w-[320px]"
              >
                <option value="">— no run anchored —</option>
                {voiceRuns.map((r) => (
                  <option key={r.run_id} value={r.run_id}>
                    {r.topic || r.run_id.slice(0, 8)} · {r.status} · {r.created_at.slice(0, 10)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-pressed={selection?.kind === "voice-config"}
              onClick={() => setSelectedId(VOICE_SETTINGS_ID)}
              className={cn(
                "font-mono text-[11px] tracking-[0.14em] uppercase px-3 py-1.5 border border-rule transition-colors",
                selection?.kind === "voice-config"
                  ? "bg-ink text-paper"
                  : "text-ink-faint hover:text-ink hover:bg-paper-deep/40",
              )}
            >
              ⬡ Voice settings
            </button>
          </div>
        </div>

        {/* Unsaved-draft toolbar (Phase 5): quiet until dirty, then an amber
            count + the unified Save-all, an optional batch note, and Discard. */}
        {unsavedCount > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule pt-3">
            <span
              className="font-mono text-[11px] uppercase tracking-[0.14em] text-amber-700"
              aria-live="polite"
            >
              ● {unsavedCount} unsaved
            </span>
            <input
              type="text"
              value={batchNote}
              maxLength={500}
              onChange={(e) => setBatchNote(e.target.value)}
              placeholder="Optional batch note (stamped on each prompt history row)"
              className="flex-1 min-w-[200px] max-w-[440px] font-mono text-[11.5px] text-ink bg-paper-deep/30 border border-rule rounded-sm px-2.5 py-1.5 outline-none focus-visible:border-accent placeholder:text-ink-faint"
            />
            <div className="flex items-center gap-2">
              {showDiscard ? (
                <>
                  <span className="font-mono text-[10.5px] text-ink-soft">Discard all drafts?</span>
                  <button
                    type="button"
                    onClick={handleDiscardAll}
                    disabled={isSaving}
                    className="font-mono text-[11px] uppercase tracking-wider px-2.5 py-1.5 border border-accent-deep text-accent-deep rounded-sm hover:bg-rose-50 transition-colors"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDiscard(false)}
                    className="font-mono text-[11px] uppercase tracking-wider px-2.5 py-1.5 border border-rule text-ink-faint rounded-sm hover:text-ink transition-colors"
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDiscard(true)}
                  disabled={isSaving}
                  className="font-mono text-[11px] uppercase tracking-wider px-2.5 py-1.5 border border-rule text-ink-faint rounded-sm hover:text-ink hover:bg-paper-deep/40 transition-colors"
                >
                  Discard all
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleSaveAll()}
                disabled={isSaving}
                className="font-mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm bg-amber-500 text-ink hover:bg-amber-400 transition-colors disabled:opacity-60"
              >
                {isSaving ? "Saving…" : `Save all · ${unsavedCount}`}
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {graphQ.isPending && (
            <p className="p-8 text-ink-faint">Loading pipeline…</p>
          )}
          {graphQ.isError && (
            <p className="p-8 text-accent-deep text-[13px]">Failed to load the graph.</p>
          )}
          {graphQ.data && (
            <VoiceStudioCanvas
              graph={graphQ.data}
              partials={partials}
              ownershipById={ownershipById}
              overlay={overlay}
              onSelect={setSelectedId}
            />
          )}
          {anchoredRun && overlay && !overlay.modeMatches && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center px-4 pt-3">
              <p className="pointer-events-auto bg-paper border border-rule rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint shadow-sm">
                Anchored run ran in{" "}
                <span className="text-ink">{graphModeForRun(anchoredRun)}</span> mode — switch the
                mode tab to overlay its execution
              </p>
            </div>
          )}
          {runId !== null && logsQ.isError && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center px-4 pt-3">
              <p className="pointer-events-auto bg-paper border border-accent-deep/40 rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-accent-deep shadow-sm">
                Failed to load run logs — execution overlay unavailable
              </p>
            </div>
          )}
        </div>

        {selection && (
          <aside className="w-[50vw] min-w-[460px] max-w-[860px] shrink-0">
            <StudioInspector
              selection={selection}
              voice={slug}
              runId={runId}
              onClose={() => setSelectedId(null)}
              onStudioSave={() => void handleSaveAll()}
              isStudioSaving={isSaving}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
