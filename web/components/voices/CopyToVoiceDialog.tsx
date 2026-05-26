"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { personasApi } from "@/lib/api";
import type { GlossaryEntry, Persona } from "@/lib/types";
import { cn } from "@/lib/utils";

type Resolution = "overwrite" | "keep" | "merge_variants";

interface Row {
  source: GlossaryEntry;
  target: GlossaryEntry | null;
  resolution: Resolution;
  include: boolean;
}

interface CopyToVoiceDialogProps {
  sourcePersona: Persona;
  candidates: Persona[];
  onClose: () => void;
}

function mergeVariants(a: GlossaryEntry, b: GlossaryEntry): GlossaryEntry {
  const variants = Array.from(new Set([...a.variants, ...b.variants]));
  return { ...b, variants };
}

export function CopyToVoiceDialog({ sourcePersona, candidates, onClose }: CopyToVoiceDialogProps) {
  const qc = useQueryClient();
  const [targetSlug, setTargetSlug] = useState<string | null>(null);
  const target = candidates.find((p) => p.slug === targetSlug) ?? null;

  const rows: Row[] = useMemo(() => {
    if (!target) return [];
    return sourcePersona.glossary.map((src) => {
      const existing = target.glossary.find(
        (t) => t.term.trim().toLowerCase() === src.term.trim().toLowerCase(),
      ) ?? null;
      return {
        source: src,
        target: existing,
        resolution: existing ? "keep" : "overwrite",
        include: true,
      };
    });
  }, [sourcePersona.glossary, target]);

  const [overrides, setOverrides] = useState<Record<string, { resolution?: Resolution; include?: boolean }>>({});

  const computed: Row[] = rows.map((r) => {
    const o = overrides[r.source.term.toLowerCase()] ?? {};
    return {
      ...r,
      resolution: o.resolution ?? r.resolution,
      include: o.include ?? r.include,
    };
  });

  const conflictCount = computed.filter((r) => r.target).length;
  const newCount = computed.filter((r) => !r.target && r.include).length;
  const willApply = computed.filter((r) => r.include).length;

  const mut = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("No target voice selected.");
      const targetByTerm = new Map<string, GlossaryEntry>(
        target.glossary.map((e) => [e.term.trim().toLowerCase(), e]),
      );
      for (const r of computed) {
        if (!r.include) continue;
        const key = r.source.term.trim().toLowerCase();
        const existing = targetByTerm.get(key);
        if (!existing) {
          targetByTerm.set(key, r.source);
          continue;
        }
        if (r.resolution === "overwrite") targetByTerm.set(key, r.source);
        else if (r.resolution === "merge_variants") {
          targetByTerm.set(key, mergeVariants(r.source, existing));
        }
      }
      const merged = Array.from(targetByTerm.values());
      return personasApi.update(target.slug, { glossary: merged });
    },
    onSuccess: (p) => {
      toast.success(`Copied ${willApply} term(s) to "${p.name}"`);
      qc.invalidateQueries({ queryKey: ["personas"] });
      qc.invalidateQueries({ queryKey: ["persona", p.slug] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setRow = (key: string, patch: { resolution?: Resolution; include?: boolean }) => {
    setOverrides((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), ...patch } }));
  };

  return (
    <>
      <div className="fixed inset-0 bg-ink/30 z-40" onClick={onClose} aria-hidden />
      <div className="fixed inset-x-0 top-10 mx-auto z-50 max-w-[920px] bg-paper border border-rule shadow-2xl max-h-[85vh] flex flex-col">
        <header className="flex items-center justify-between border-b border-rule px-5 py-3">
          <div>
            <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">
              Copy glossary
            </p>
            <p className="font-display text-[22px] text-ink">
              From <span className="text-accent-deep">{sourcePersona.name}</span> →
              {" "}
              <select
                value={targetSlug ?? ""}
                onChange={(e) => { setTargetSlug(e.target.value || null); setOverrides({}); }}
                className="bg-transparent border-b border-rule text-[22px] font-display focus:outline-none"
              >
                <option value="">choose voice…</option>
                {candidates.map((p) => (
                  <option key={p.slug} value={p.slug}>{p.name}</option>
                ))}
              </select>
            </p>
          </div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">×</button>
        </header>

        {!target && (
          <p className="px-5 py-10 text-center font-mono text-[11px] tracking-wider uppercase text-ink-faint">
            Pick a destination voice to preview the merge.
          </p>
        )}

        {target && sourcePersona.glossary.length === 0 && (
          <p className="px-5 py-10 text-center font-mono text-[11px] tracking-wider uppercase text-ink-faint">
            This voice has no glossary entries to copy.
          </p>
        )}

        {target && sourcePersona.glossary.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-4 border-b border-rule bg-paper-deep/30 px-5 py-3 font-mono text-[11px] tracking-wider uppercase text-ink-faint">
              <span>{newCount} new</span>
              <span>{conflictCount} conflicting</span>
              <span className="text-ink">{willApply} will apply</span>
            </div>

            <div className="overflow-y-auto flex-1">
              <div className="grid grid-cols-[28px_1.4fr_1.4fr_1.4fr_1.6fr] gap-2 border-b border-rule bg-paper-deep/40 px-4 py-2 font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint sticky top-0">
                <span aria-label="include" />
                <span>Term</span>
                <span>Source ({sourcePersona.name})</span>
                <span>Target ({target.name})</span>
                <span>Action</span>
              </div>
              {computed.map((r) => {
                const key = r.source.term.toLowerCase();
                const conflict = !!r.target;
                return (
                  <div
                    key={key}
                    className={cn(
                      "grid grid-cols-[28px_1.4fr_1.4fr_1.4fr_1.6fr] gap-2 items-start border-b border-rule px-4 py-2",
                      !r.include && "opacity-50",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) => setRow(key, { include: e.target.checked })}
                      className="mt-1"
                    />
                    <span className="font-display text-[16px] text-ink">{r.source.term}</span>
                    <div className="text-[12px] text-ink-soft">
                      <p>{r.source.preferred || "—"}</p>
                      {r.source.variants.length > 0 && (
                        <p className="font-mono text-[11px] text-ink-faint">
                          avoid: {r.source.variants.join(", ")}
                        </p>
                      )}
                      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                        {r.source.status}
                      </p>
                    </div>
                    <div className="text-[12px] text-ink-soft">
                      {r.target ? (
                        <>
                          <p>{r.target.preferred || "—"}</p>
                          {r.target.variants.length > 0 && (
                            <p className="font-mono text-[11px] text-ink-faint">
                              avoid: {r.target.variants.join(", ")}
                            </p>
                          )}
                          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                            {r.target.status}
                          </p>
                        </>
                      ) : (
                        <p className="italic text-ink-faint">— not present —</p>
                      )}
                    </div>
                    <div className="text-[12px] space-y-1">
                      {!conflict ? (
                        <span className="font-mono text-[11px] uppercase tracking-wider text-ink">add new</span>
                      ) : (
                        <>
                          <label className="block">
                            <input
                              type="radio"
                              checked={r.resolution === "overwrite"}
                              onChange={() => setRow(key, { resolution: "overwrite" })}
                            />{" "}
                            Overwrite target
                          </label>
                          <label className="block">
                            <input
                              type="radio"
                              checked={r.resolution === "merge_variants"}
                              onChange={() => setRow(key, { resolution: "merge_variants" })}
                            />{" "}
                            Merge variants
                          </label>
                          <label className="block">
                            <input
                              type="radio"
                              checked={r.resolution === "keep"}
                              onChange={() => setRow(key, { resolution: "keep" })}
                            />{" "}
                            Keep target as-is
                          </label>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <footer className="flex items-center justify-between border-t border-rule px-5 py-3">
              <p className="font-mono text-[10px] tracking-wider uppercase text-ink-faint">
                Target glossary will be saved via PUT /personas/{target.slug}
              </p>
              <div className="flex items-center gap-3">
                <button onClick={onClose} className="text-[12px] uppercase tracking-wider text-ink-faint hover:text-ink">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={mut.isPending || willApply === 0}
                  onClick={() => mut.mutate()}
                  className="bg-ink text-paper px-4 py-2 text-[12px] tracking-wider uppercase disabled:opacity-40"
                >
                  {mut.isPending ? "Copying…" : `Apply to ${target.name}`}
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </>
  );
}
