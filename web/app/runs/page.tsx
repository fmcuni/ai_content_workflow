import { Suspense } from "react";

import { RunsBoard } from "@/components/grid/RunsBoard";
import { SectionHead } from "@/components/SectionHead";

// The Ledger — a dense, grouped operations board over the same runs + topic
// batches the Desk ("/") triages. RunsBoard reads tab/search/voice from the URL
// (useSearchParams), so it sits behind a Suspense boundary per Next 16.
export default function RunsLedgerPage() {
  return (
    <div className="mx-auto max-w-[1320px] px-5 md:px-10 py-10">
      <SectionHead
        kicker="The Ledger · Live"
        hed="Runs"
        dek="Every rewrite, new article and topic batch as one board — grouped by where it stands, with destinations and state in one scannable row. Drill into a batch to see the articles it spawned."
      />
      <Suspense fallback={<p className="text-ink-faint mt-8 text-[13px]">Loading the ledger…</p>}>
        <RunsBoard />
      </Suspense>
    </div>
  );
}
