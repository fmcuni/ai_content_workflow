"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { AutoAcceptField } from "@/components/AutoAcceptField";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_PERSONA,
  LedgerDoneBanner,
  LedgerFooter,
  LedgerHeader,
  LedgerRowView,
  useLedgerRows,
  useLedgerSubmit,
} from "@/components/topics/ledger-row";
import { personasApi } from "@/lib/api";

export function CreateLedger() {
  const { rows, expanded, setExpanded, patchRow, addRow, removeRow } = useLedgerRows("c");
  const [autoAccept, setAutoAccept] = useState(false);

  const personasQ = useQuery({
    queryKey: ["personas-active"],
    queryFn: () => personasApi.list(false),
  });
  const personas = personasQ.data ?? [];

  const filledRows = useMemo(() => rows.filter((r) => r.topic.trim()), [rows]);
  const allDone = filledRows.length > 0 && filledRows.every((r) => r.status === "done");

  const submitMut = useLedgerSubmit({
    rows,
    patchRow,
    isReady: (r) => Boolean(r.topic.trim()),
    buildRequest: (r) => ({
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
      auto_accept_hitl1: autoAccept,
    }),
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
        <LedgerHeader variant="create" />

        {rows.map((row, idx) => (
          <LedgerRowView
            key={row.uid}
            row={row}
            index={idx}
            variant="create"
            personas={personas}
            personasLoading={personasQ.isLoading}
            isOpen={expanded === row.uid}
            onToggle={() => setExpanded(expanded === row.uid ? null : row.uid)}
            onPatch={(p) => patchRow(row.uid, p)}
            onRemove={() => removeRow(row.uid)}
          />
        ))}

        <LedgerFooter
          rowCount={rows.length}
          readyCount={filledRows.length}
          filedCount={filedCount}
          onAddRow={addRow}
        />
      </div>

      <AutoAcceptField checked={autoAccept} onChange={setAutoAccept} />

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
        <LedgerDoneBanner note="Drafts filed. Each run publishes to WordPress as a draft after HITL_2." />
      )}
    </section>
  );
}
