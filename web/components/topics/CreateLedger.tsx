"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, personasApi } from "@/lib/api";
import type { CreateRunRequest, Persona } from "@/lib/types";
import { cn } from "@/lib/utils";

type RowStatus = "idle" | "submitting" | "done" | "error";

interface CreateRow {
  uid: string;
  topic: string;
  keywords: string;
  persona: string;
  edit_note: string;
  acf_adv_id: number;
  acf_widget_id: number;
  status: RowStatus;
  result: { run_id?: string; error?: string } | null;
}

const DEFAULT_PERSONA = "bowtie-editor";

let _uid = 0;
const nextUid = () => `c${++_uid}-${Date.now().toString(36)}`;

function blankRow(persona = DEFAULT_PERSONA): CreateRow {
  return {
    uid: nextUid(),
    topic: "",
    keywords: "",
    persona,
    edit_note: "",
    acf_adv_id: 0,
    acf_widget_id: 0,
    status: "idle",
    result: null,
  };
}

export function CreateLedger() {
  const router = useRouter();
  const [rows, setRows] = useState<CreateRow[]>(() => [blankRow(), blankRow(), blankRow()]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const personasQ = useQuery({
    queryKey: ["personas-active"],
    queryFn: () => personasApi.list(false),
  });
  const personas = personasQ.data ?? [];

  const filledRows = useMemo(() => rows.filter((r) => r.topic.trim()), [rows]);
  const allDone = filledRows.length > 0 && filledRows.every((r) => r.status === "done");

  function patchRow(uid: string, patch: Partial<CreateRow>) {
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, blankRow(rs[rs.length - 1]?.persona ?? DEFAULT_PERSONA)]);
  }
  function removeRow(uid: string) {
    setRows((rs) => (rs.length === 1 ? [blankRow()] : rs.filter((r) => r.uid !== uid)));
    if (expanded === uid) setExpanded(null);
  }

  const submitMut = useMutation({
    mutationFn: async () => {
      const targets = rows.filter((r) => r.topic.trim() && r.status !== "done");
      const results: { uid: string; run_id?: string; error?: string }[] = [];
      for (const r of targets) {
        patchRow(r.uid, { status: "submitting", result: null });
        try {
          const req: CreateRunRequest = {
            start_mode: "create",
            topic: r.topic.trim(),
            keywords: r.keywords.split(",").map((s) => s.trim()).filter(Boolean),
            mode: "auto",
            persona: r.persona || DEFAULT_PERSONA,
            edit_note: r.edit_note.trim() || null,
            acf_adv_id: r.acf_adv_id,
            acf_widget_id: r.acf_widget_id,
            topic_category: null,
            editor_email: "",
            topic_candidate_id: null,
          };
          const res = await api.createRun(req);
          patchRow(r.uid, { status: "done", result: { run_id: res.run_id } });
          results.push({ uid: r.uid, run_id: res.run_id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          patchRow(r.uid, { status: "error", result: { error: msg } });
          results.push({ uid: r.uid, error: msg });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => r.run_id);
      if (ok.length === 1 && results.length === 1) {
        router.push(`/runs/${ok[0].run_id}`);
      }
    },
  });

  const filedCount = rows.filter((r) => r.status === "done").length;
  const pending = filledRows.filter((r) => r.status !== "done").length;

  return (
    <section aria-labelledby="create-ledger-title" className="space-y-4">
      <div className="flex items-end justify-between gap-4 border-b border-ink pb-3">
        <div>
          <p className="kicker">Front III · Creation Ledger</p>
          <h2
            id="create-ledger-title"
            className="hed text-[28px] mt-1"
            style={{ fontVariationSettings: '"opsz" 36, "SOFT" 60' }}
          >
            Commission fresh pieces
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-soft">
            Each row becomes a create-mode run. Publication lands in WordPress as a draft.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={addRow} type="button">
          + Add row
        </Button>
      </div>

      <div className="border border-rule overflow-hidden">
        <div className="hidden md:grid grid-cols-[40px_minmax(0,2.2fr)_minmax(0,1.8fr)_108px_minmax(0,1.1fr)_88px_88px_36px_36px] bg-paper-deep border-b border-rule">
          {(["№", "Topic", "Focus keywords", "Mode", "Voice", "ADV", "Widget", "", ""] as const).map(
            (t, i) => (
              <div
                key={i}
                className={cn(
                  "px-3 py-2 kicker border-r border-rule last:border-r-0",
                  i === 0 && "text-center",
                )}
              >
                {t}
              </div>
            ),
          )}
        </div>

        {rows.map((row, idx) => (
          <CreateRowView
            key={row.uid}
            row={row}
            index={idx}
            personas={personas}
            personasLoading={personasQ.isLoading}
            isOpen={expanded === row.uid}
            onToggle={() => setExpanded(expanded === row.uid ? null : row.uid)}
            onPatch={(p) => patchRow(row.uid, p)}
            onRemove={() => removeRow(row.uid)}
          />
        ))}

        <div className="flex items-center justify-between gap-4 px-3 py-2 bg-paper-deep/60 border-t border-rule">
          <p className="font-mono text-[11px] text-ink-faint">
            {rows.length} row{rows.length === 1 ? "" : "s"} · {filledRows.length} ready to file
            {filedCount > 0 && (
              <>
                {" "}
                · <span className="text-ok">{filedCount} filed</span>
              </>
            )}
          </p>
          <button
            type="button"
            onClick={addRow}
            className="font-mono text-[11px] text-ink-soft hover:text-ink underline underline-offset-2"
          >
            + new row
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 pt-2">
        <Link href="/" className="text-[12px] text-ink-soft hover:text-ink">
          ↩ Back to the desk
        </Link>
        <div className="flex items-center gap-4">
          {submitMut.isError && (
            <p className="text-accent-deep text-[12px] font-mono">
              {(submitMut.error as Error).message}
            </p>
          )}
          <Button
            onClick={() => submitMut.mutate()}
            disabled={submitMut.isPending || pending === 0}
            size="lg"
          >
            {submitMut.isPending
              ? `Filing ${filledRows.length}…`
              : `File ${pending} create-run${pending === 1 ? "" : "s"} →`}
          </Button>
        </div>
      </div>

      {allDone && (
        <div className="flex flex-col items-center gap-1 pt-6 pb-2">
          <p
            className="font-display text-[22px] tracking-[0.4em] text-ink-faint"
            style={{ fontStyle: "italic" }}
          >
            — 30 —
          </p>
          <p className="font-mono text-[10.5px] text-ink-faint">
            Drafts filed. Each run publishes to WordPress as a draft after HITL_2.
          </p>
        </div>
      )}
    </section>
  );
}

interface CreateRowViewProps {
  row: CreateRow;
  index: number;
  personas: Persona[];
  personasLoading: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<CreateRow>) => void;
  onRemove: () => void;
}

function CreateRowView({
  row,
  index,
  personas,
  personasLoading,
  isOpen,
  onToggle,
  onPatch,
  onRemove,
}: CreateRowViewProps) {
  const status = row.status;
  const statusDot =
    status === "done"
      ? "bg-ok"
      : status === "submitting"
        ? "bg-warn animate-pulse"
        : status === "error"
          ? "bg-accent-deep"
          : "bg-rule";

  const selectClasses =
    "h-9 w-full bg-transparent text-[13px] text-ink border-0 border-b border-rule rounded-none px-0 py-1.5 outline-none focus-visible:border-b-2 focus-visible:border-accent appearance-none cursor-pointer";

  return (
    <div
      className={cn(
        "border-b border-rule last:border-b-0",
        status === "done" && "bg-ok/[0.04]",
        status === "error" && "bg-accent/[0.05]",
      )}
    >
      <div className="grid grid-cols-1 md:grid-cols-[40px_minmax(0,2.2fr)_minmax(0,1.8fr)_108px_minmax(0,1.1fr)_88px_88px_36px_36px]">
        <div className="flex items-center justify-center md:border-r border-rule px-2 py-2 relative">
          <span
            className="font-display text-[20px] text-ink-faint tabular-nums leading-none"
            style={{ fontVariationSettings: '"opsz" 36' }}
          >
            {String(index + 1).padStart(2, "0")}
          </span>
          <span
            aria-hidden
            className={cn("absolute right-1 top-1 size-1.5 rounded-full", statusDot)}
            title={status}
          />
        </div>

        <Cell label="Topic">
          <Input
            value={row.topic}
            onChange={(e) => onPatch({ topic: e.target.value })}
            placeholder="Article topic"
          />
        </Cell>

        <Cell label="Focus keywords">
          <Input
            value={row.keywords}
            onChange={(e) => onPatch({ keywords: e.target.value })}
            placeholder="kw1, kw2, kw3"
          />
        </Cell>

        <Cell label="Mode">
          <span
            className={cn(
              "inline-flex items-center h-9 px-2 font-mono text-[11px] tracking-[0.16em] uppercase",
              "text-accent-deep border-b border-rule",
            )}
            aria-label="mode: create"
          >
            Create
          </span>
        </Cell>

        <Cell label="Voice">
          <select
            value={row.persona}
            onChange={(e) => onPatch({ persona: e.target.value })}
            className={selectClasses}
            disabled={personasLoading}
          >
            {personasLoading && <option>Loading voices…</option>}
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
              !personas.some((p) => p.slug === row.persona) && (
                <option value={row.persona}>{row.persona} (unknown)</option>
              )}
          </select>
        </Cell>

        <Cell label="ADV">
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={row.acf_adv_id === 0 ? "" : row.acf_adv_id}
            onChange={(e) =>
              onPatch({ acf_adv_id: parseInt(e.target.value.replace(/\D/g, "") || "0", 10) })
            }
            placeholder="none"
            className="font-mono text-[12px] tabular-nums"
            aria-label="acf_adv_id"
          />
        </Cell>

        <Cell label="Widget">
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={row.acf_widget_id === 0 ? "" : row.acf_widget_id}
            onChange={(e) =>
              onPatch({ acf_widget_id: parseInt(e.target.value.replace(/\D/g, "") || "0", 10) })
            }
            placeholder="none"
            className="font-mono text-[12px] tabular-nums"
            aria-label="acf_widget_id"
          />
        </Cell>

        <div className="md:border-l border-rule flex items-center justify-center px-1 py-2">
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              "size-6 inline-flex items-center justify-center font-mono text-[14px] text-ink-soft hover:text-ink hover:bg-paper-deep transition-colors",
              isOpen && "bg-paper-deep text-ink",
            )}
            aria-label="More fields"
            title="Edit note"
          >
            {isOpen ? "−" : "+"}
          </button>
        </div>

        <div className="md:border-l border-rule flex items-center justify-center px-1 py-2">
          <button
            type="button"
            onClick={onRemove}
            className="size-6 inline-flex items-center justify-center font-mono text-[13px] text-ink-faint hover:text-accent-deep transition-colors"
            aria-label="Remove row"
            title="Strike row"
          >
            ×
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="grid grid-cols-1 md:grid-cols-[40px_1fr] border-t border-rule bg-paper-deep/40">
          <div className="hidden md:block md:border-r border-rule" />
          <div className="px-4 py-4">
            <label className="flex flex-col gap-1">
              <span className="kicker">Edit note</span>
              <Textarea
                value={row.edit_note}
                onChange={(e) => onPatch({ edit_note: e.target.value })}
                rows={2}
                placeholder="What the desk wants on this run."
                className="bg-paper"
              />
            </label>
          </div>
        </div>
      )}

      {row.result && (
        <div
          className={cn(
            "px-3 py-1.5 font-mono text-[11px] flex items-center justify-between gap-3 border-t border-rule",
            status === "done" && "bg-ok/[0.08] text-ok",
            status === "error" && "bg-accent/[0.08] text-accent-deep",
          )}
        >
          {status === "done" && row.result.run_id && (
            <>
              <span>FILED · run_id {row.result.run_id.slice(0, 8)}…</span>
              <Link
                href={`/runs/${row.result.run_id}`}
                className="underline underline-offset-2 hover:text-ink"
              >
                Open run →
              </Link>
            </>
          )}
          {status === "error" && row.result.error && <span>ERROR · {row.result.error}</span>}
        </div>
      )}
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="md:border-r border-rule px-3 py-2">
      <span className="md:hidden kicker mb-1 block">{label}</span>
      {children}
    </div>
  );
}
