"use client";

import { DeskRow } from "@/components/desk/DeskRow";
import { batchToItem, runToItem, type TabKey } from "@/lib/desk-items";
import { byNewest, GROUPS } from "@/lib/runs-grid/groups";
import { buildRecords } from "@/lib/runs-grid/select";
import type { RunSummary, TopicBatch } from "@/lib/types";

interface GroupedDeskFallbackProps {
  runs: readonly RunSummary[];
  batches: readonly TopicBatch[];
  tab: TabKey;
  search: string;
  voice: string;
}

/**
 * Below lg, the columnar ledger degrades to the Desk's stacked cards (reusing
 * DeskRow), but kept grouped by the board's four status groups so the mobile and
 * desktop views read the same way. Read-only — no inline gate actions here.
 */
export function GroupedDeskFallback({ runs, batches, tab, search, voice }: GroupedDeskFallbackProps) {
  const records = buildRecords(tab, runs, batches, search, voice);

  if (records.length === 0) {
    return (
      <p className="font-display italic text-ink-faint text-[16px] mt-6">
        Nothing filed under this edition.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {GROUPS.map((group) => {
        const inGroup = records.filter((r) => r.group === group.key).sort(byNewest);
        if (inGroup.length === 0) return null;
        return (
          <section key={group.key}>
            <div className="flex items-baseline justify-between mb-1">
              <h2 className="kicker">
                {group.label} <span className="text-ink">· {inGroup.length}</span>
              </h2>
              {group.hint ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  {group.hint}
                </span>
              ) : null}
            </div>
            <ul className="border-t border-rule">
              {inGroup.map((rec) => (
                <DeskRow
                  key={`${rec.kind}:${rec.id}`}
                  item={rec.kind === "batch" ? batchToItem(rec.batch) : runToItem(rec.run)}
                  accent={group.key === "review"}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
