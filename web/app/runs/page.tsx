import { Suspense } from "react";

import { RunsLedger } from "@/components/runs-ledger/RunsLedger";

// The Runs Ledger (spec 2026-06-12): a dense, tab-filtered table over every run
// with a bottom-sheet review drawer and client-side bulk actions. The masthead
// (app/layout.tsx) provides the page chrome; this page renders the ledger inside
// a Suspense boundary (its hooks read TanStack Query / role on the client).
export default function RunsLedgerPage() {
  return (
    <Suspense fallback={<p className="mt-8 px-7 text-[13px] text-ink-faint">Loading the ledger…</p>}>
      <RunsLedger />
    </Suspense>
  );
}
