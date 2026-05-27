"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { personasApi, topicBatchesApi } from "@/lib/api";
import type {
  Persona,
  PromoteResponse,
  PromotionItem,
  TopicBatch,
  TopicCandidate,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { VerdictBadge } from "./VerdictBadge";

const DEFAULT_PERSONA = "bowtie-editor";

interface CandidateGridProps {
  batch: TopicBatch;
}

interface LocalRowState {
  topic: string;
  keywords: string;
  persona: string;
  acf_adv_id: number;
  acf_widget_id: number;
  promote_mode: "create" | "refresh";
  selected: boolean;
}

function rowFromCandidate(c: TopicCandidate, fallbackPersona: string): LocalRowState {
  return {
    topic: c.topic,
    keywords: c.keywords.join(", "),
    persona: c.persona_slug ?? fallbackPersona,
    acf_adv_id: c.acf_adv_id ?? 1,
    acf_widget_id: c.acf_widget_id ?? 1,
    promote_mode: c.promote_mode ?? "create",
    selected: c.status === "candidate" && c.existing === "no",
  };
}

export function CandidateGrid({ batch }: CandidateGridProps) {
  const qc = useQueryClient();
  const candidates = useMemo(() => batch.candidates ?? [], [batch.candidates]);
  const fallbackPersona = batch.persona_default ?? DEFAULT_PERSONA;

  const personasQ = useQuery({
    queryKey: ["personas-active"],
    queryFn: () => personasApi.list(false),
  });
  const personas: Persona[] = personasQ.data ?? [];

  const [local, setLocal] = useState<Record<string, LocalRowState>>(() =>
    Object.fromEntries(
      candidates.map((c) => [c.candidate_id, rowFromCandidate(c, fallbackPersona)]),
    ),
  );

  useEffect(() => {
    setLocal((prev) => {
      const next = { ...prev };
      for (const c of candidates) {
        if (!next[c.candidate_id]) {
          next[c.candidate_id] = rowFromCandidate(c, fallbackPersona);
        }
      }
      return next;
    });
  }, [candidates, fallbackPersona]);

  const patchTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  function schedulePatch(
    candidateId: string,
    body: Parameters<typeof topicBatchesApi.patchCandidate>[2],
  ): void {
    if (patchTimers.current[candidateId]) clearTimeout(patchTimers.current[candidateId]);
    patchTimers.current[candidateId] = setTimeout(async () => {
      try {
        const updated = await topicBatchesApi.patchCandidate(batch.batch_id, candidateId, body);
        qc.setQueryData<TopicBatch>(["topic-batch", batch.batch_id], (prev) => {
          if (!prev?.candidates) return prev;
          return {
            ...prev,
            candidates: prev.candidates.map((c) =>
              c.candidate_id === candidateId ? updated : c,
            ),
          };
        });
      } catch (err) {
        console.warn("patch candidate failed", err);
      }
    }, 600);
  }

  function patchLocal(candidateId: string, patch: Partial<LocalRowState>): void {
    setLocal((prev) => ({ ...prev, [candidateId]: { ...prev[candidateId], ...patch } }));
  }

  const skipMut = useMutation({
    mutationFn: async (candidateId: string) =>
      topicBatchesApi.skip(batch.batch_id, candidateId, ""),
    onSuccess: (cand) => {
      qc.setQueryData<TopicBatch>(["topic-batch", batch.batch_id], (prev) => {
        if (!prev?.candidates) return prev;
        return {
          ...prev,
          candidates: prev.candidates.map((c) =>
            c.candidate_id === cand.candidate_id ? cand : c,
          ),
        };
      });
    },
  });

  function skipAllExisting() {
    const targets = candidates.filter(
      (c) => c.status === "candidate" && c.existing === "yes",
    );
    targets.forEach((c) => skipMut.mutate(c.candidate_id));
  }

  const promoteMut = useMutation({
    mutationFn: async (promotions: PromotionItem[]): Promise<PromoteResponse> =>
      topicBatchesApi.promote(batch.batch_id, { promotions, editor_email: "" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["topic-batch", batch.batch_id] });
    },
  });

  const reviewable = candidates.filter((c) => c.status === "candidate");
  const promotedRows = candidates.filter((c) => c.status === "promoted");
  const skippedCount = candidates.filter((c) => c.status === "skipped").length;
  const verdictsReady = (c: TopicCandidate): boolean =>
    c.existing != null && c.hot_topic != null;

  const selectedIds = reviewable
    .filter((c) => local[c.candidate_id]?.selected && verdictsReady(c))
    .map((c) => c.candidate_id);
  const n_create = selectedIds.filter(
    (id) => (local[id]?.promote_mode ?? "create") === "create",
  ).length;
  const n_refresh = selectedIds.length - n_create;

  function submitCommission() {
    const promotions: PromotionItem[] = selectedIds.map((id) => ({
      candidate_id: id,
      mode: local[id]?.promote_mode ?? "create",
    }));
    if (promotions.length === 0) return;
    promoteMut.mutate(promotions);
  }

  return (
    <section aria-labelledby="candidate-grid-title" className="space-y-5">
      <div className="border-b border-rule pb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="kicker">Front II · HITL_T1 · Story budget</p>
          <h2
            id="candidate-grid-title"
            className="hed text-[24px] mt-1"
            style={{ fontVariationSettings: '"opsz" 36, "SOFT" 60' }}
          >
            {batch.research_theme}
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-soft">
            {reviewable.length} on the table · {promotedRows.length} commissioned ·{" "}
            {skippedCount} skipped
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={skipAllExisting}>
            Skip all <span className="font-mono">existing=yes</span>
          </Button>
        </div>
      </div>

      <div className="border border-rule overflow-x-auto">
        <div className="min-w-[1100px]">
          <div className="sticky top-0 z-10 grid grid-cols-[32px_28px_minmax(0,2.4fr)_minmax(0,2.2fr)_140px_minmax(0,1.2fr)_64px_64px_120px_36px] bg-paper-deep border-b border-rule">
            {(
              [
                "№",
                "",
                "Topic",
                "Focus keywords",
                "Verdict",
                "Voice",
                "ADV",
                "Widget",
                "Mode",
                "",
              ] as const
            ).map((t, i) => (
              <div
                key={i}
                className={cn(
                  "px-2 py-2 kicker border-r border-rule last:border-r-0",
                  i === 0 && "text-center",
                )}
              >
                {t}
              </div>
            ))}
          </div>

          {candidates.map((c, idx) => (
            <CandidateRow
              key={c.candidate_id}
              candidate={c}
              index={idx}
              local={local[c.candidate_id]}
              personas={personas}
              personasLoading={personasQ.isLoading}
              onLocal={(patch) => patchLocal(c.candidate_id, patch)}
              onPatchServer={(body) => schedulePatch(c.candidate_id, body)}
              onSkip={() => skipMut.mutate(c.candidate_id)}
            />
          ))}
        </div>
      </div>

      {promoteMut.data && (
        <div className="border border-ok/40 bg-ok/[0.06] px-3 py-2 text-[12px]">
          <p className="kicker text-ok">Commissioned · {promoteMut.data.items.length} run(s)</p>
          <ul className="mt-1 font-mono text-[11.5px] space-y-0.5">
            {promoteMut.data.items.map((it) => (
              <li key={it.candidate_id} className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex items-center px-1.5 py-[1px] uppercase tracking-[0.14em] text-[10px] border",
                    it.mode === "create"
                      ? "text-accent-deep border-accent/40 bg-accent/[0.06]"
                      : "text-ok border-ok/40 bg-ok/[0.06]",
                  )}
                >
                  {it.mode}
                </span>
                <Link
                  href={`/runs/${it.run_id}`}
                  className="text-ink hover:underline underline-offset-2"
                >
                  Open run {it.run_id.slice(0, 8)}… →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 pt-2 border-t border-rule">
        <Link
          href="/runs/new?front=topics"
          className="text-[12px] text-ink-soft hover:text-ink"
        >
          ↩ New brief
        </Link>
        <div className="flex items-center gap-4">
          {promoteMut.isError && (
            <p className="text-accent-deep text-[12px] font-mono">
              {(promoteMut.error as Error).message}
            </p>
          )}
          <Button
            type="button"
            size="lg"
            disabled={promoteMut.isPending || selectedIds.length === 0}
            onClick={submitCommission}
          >
            {promoteMut.isPending
              ? `Commissioning ${selectedIds.length}…`
              : selectedIds.length === 0
                ? "Commission 0"
                : n_refresh > 0
                  ? `Commission ${selectedIds.length} → (${n_create} new · ${n_refresh} refresh)`
                  : `Commission ${selectedIds.length} →`}
          </Button>
        </div>
      </div>
    </section>
  );
}

interface CandidateRowProps {
  candidate: TopicCandidate;
  index: number;
  local: LocalRowState | undefined;
  personas: Persona[];
  personasLoading: boolean;
  onLocal: (patch: Partial<LocalRowState>) => void;
  onPatchServer: (body: Parameters<typeof topicBatchesApi.patchCandidate>[2]) => void;
  onSkip: () => void;
}

function CandidateRow({
  candidate,
  index,
  local,
  personas,
  personasLoading,
  onLocal,
  onPatchServer,
  onSkip,
}: CandidateRowProps) {
  const c = candidate;
  if (!local) return null;

  const verdictsReady = c.existing != null && c.hot_topic != null;
  const editable = c.status === "candidate";
  const promoted = c.status === "promoted";
  const skipped = c.status === "skipped";
  const errored = c.last_error != null;

  const refreshEligible =
    !!c.existing_url && (c.existing === "yes" || c.existing === "not_sure");

  const liveKws = local.keywords
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const edited =
    local.topic !== c.original_topic ||
    JSON.stringify(liveKws) !== JSON.stringify(c.original_keywords);

  function commitTopic(value: string) {
    onLocal({ topic: value });
    onPatchServer({ topic: value, editor_email: "" });
  }
  function commitKeywords(value: string) {
    onLocal({ keywords: value });
    const kws = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onPatchServer({ keywords: kws, editor_email: "" });
  }

  const selectClasses =
    "h-9 w-full bg-transparent text-[13px] text-ink border-0 border-b border-rule rounded-none px-0 py-1.5 outline-none focus-visible:border-b-2 focus-visible:border-accent appearance-none cursor-pointer";

  return (
    <div
      className={cn(
        "border-b border-rule last:border-b-0",
        promoted && "bg-ok/[0.05]",
        skipped && "bg-paper-deep/60 opacity-70",
      )}
    >
      <div className="grid grid-cols-[32px_28px_minmax(0,2.4fr)_minmax(0,2.2fr)_140px_minmax(0,1.2fr)_64px_64px_120px_36px]">
        <div className="flex items-center justify-center border-r border-rule px-1 py-2">
          <span
            className="font-display text-[16px] text-ink-faint tabular-nums leading-none"
            style={{ fontVariationSettings: '"opsz" 36' }}
          >
            {String(index + 1).padStart(2, "0")}
          </span>
        </div>

        <div className="flex items-center justify-center border-r border-rule px-1 py-2">
          <input
            type="checkbox"
            checked={local.selected}
            disabled={!editable || !verdictsReady}
            onChange={(e) => onLocal({ selected: e.target.checked })}
            title={
              !editable
                ? c.status
                : verdictsReady
                  ? "Commission this candidate"
                  : "Awaiting verdicts"
            }
            className="size-3.5 accent-ink cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          />
        </div>

        <div className="border-r border-rule px-2 py-2">
          <Input
            value={local.topic}
            onChange={(e) => commitTopic(e.target.value)}
            disabled={!editable}
            className="text-[13px]"
          />
          {edited && editable && (
            <p className="mt-1 font-mono text-[10.5px] italic text-ink-faint line-clamp-1">
              edited · original &ldquo;{c.original_topic}&rdquo;
            </p>
          )}
          {c.last_edited_by && (
            <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
              last edit · {c.last_edited_by}
            </p>
          )}
        </div>

        <div className="border-r border-rule px-2 py-2">
          <Input
            value={local.keywords}
            onChange={(e) => commitKeywords(e.target.value)}
            disabled={!editable}
            placeholder="kw1, kw2, kw3"
            className="font-mono text-[12px]"
          />
        </div>

        <div className="border-r border-rule px-2 py-2 flex flex-col gap-1 items-start">
          <VerdictBadge
            kind="existing"
            verdict={c.existing}
            note={c.existing_note}
            url={c.existing_url}
          />
          <VerdictBadge kind="hot" verdict={c.hot_topic} note={c.hot_topic_note} />
          {errored && (
            <span
              title={c.last_error ?? "error"}
              className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-deep border border-accent/40 px-1.5 py-[1px] bg-accent/[0.06] line-clamp-1 max-w-[130px]"
            >
              err · {(c.last_error ?? "").slice(0, 20)}
            </span>
          )}
        </div>

        <div className="border-r border-rule px-2 py-2">
          <select
            value={local.persona}
            disabled={!editable || personasLoading}
            onChange={(e) => {
              onLocal({ persona: e.target.value });
              onPatchServer({ persona_slug: e.target.value, editor_email: "" });
            }}
            className={selectClasses}
          >
            {personasLoading && <option>Loading…</option>}
            {!personasLoading && personas.length === 0 && (
              <option value={DEFAULT_PERSONA}>{DEFAULT_PERSONA}</option>
            )}
            {personas.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
            {!personasLoading &&
              personas.length > 0 &&
              !personas.some((p) => p.slug === local.persona) && (
                <option value={local.persona}>{local.persona} (unknown)</option>
              )}
          </select>
        </div>

        <div className="border-r border-rule px-2 py-2">
          <Input
            type="number"
            disabled={!editable}
            value={local.acf_adv_id}
            onChange={(e) => {
              const n = parseInt(e.target.value || "0", 10);
              onLocal({ acf_adv_id: n });
              onPatchServer({ acf_adv_id: n, editor_email: "" });
            }}
            className="font-mono text-[12px] tabular-nums"
            aria-label="acf_adv_id"
          />
        </div>

        <div className="border-r border-rule px-2 py-2">
          <Input
            type="number"
            disabled={!editable}
            value={local.acf_widget_id}
            onChange={(e) => {
              const n = parseInt(e.target.value || "0", 10);
              onLocal({ acf_widget_id: n });
              onPatchServer({ acf_widget_id: n, editor_email: "" });
            }}
            className="font-mono text-[12px] tabular-nums"
            aria-label="acf_widget_id"
          />
        </div>

        <div className="border-r border-rule px-2 py-2 flex items-center">
          {promoted ? (
            <Link
              href={`/runs/${c.promoted_run_id ?? ""}`}
              className="font-mono text-[11px] text-ok hover:underline underline-offset-2"
            >
              run {c.promoted_run_id?.slice(0, 8)}…
            </Link>
          ) : skipped ? (
            <span className="font-mono text-[11px] text-ink-faint uppercase tracking-[0.14em]">
              skipped
            </span>
          ) : refreshEligible ? (
            <PromoteModeToggle
              value={local.promote_mode}
              onChange={(v) => onLocal({ promote_mode: v })}
            />
          ) : (
            <span className="font-mono text-[10px] text-ink-faint uppercase tracking-[0.14em]">
              create
            </span>
          )}
        </div>

        <div className="border-l border-rule flex items-center justify-center px-1 py-2">
          {editable && (
            <button
              type="button"
              onClick={onSkip}
              title="Strike row"
              aria-label="Skip candidate"
              className="size-6 inline-flex items-center justify-center font-mono text-[13px] text-ink-faint hover:text-accent-deep transition-colors"
            >
              ×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PromoteModeToggle({
  value,
  onChange,
}: {
  value: "create" | "refresh";
  onChange: (v: "create" | "refresh") => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Promotion mode"
      className="inline-flex border border-rule font-mono text-[10px] uppercase tracking-[0.14em]"
    >
      {(["create", "refresh"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "px-1.5 py-[2px] cursor-pointer",
            value === v
              ? v === "create"
                ? "bg-accent/[0.10] text-accent-deep"
                : "bg-ok/[0.10] text-ok"
              : "text-ink-faint hover:text-ink",
          )}
        >
          {v === "create" ? "new" : "refresh"}
        </button>
      ))}
    </div>
  );
}
