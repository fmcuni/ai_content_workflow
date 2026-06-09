"use client";
import type { ReactNode } from "react";
import Link from "next/link";

import { SectionHead } from "@/components/SectionHead";
import { RunTaskDetails } from "@/components/RunTaskDetails";
import type { RunSummary } from "@/lib/types";

interface RunEditorShellProps {
  runId: string;
  run: RunSummary | undefined;
  kicker: ReactNode;
  hed: ReactNode;
  dek: ReactNode;
  /** Right side of the back-link row (e.g. hitl2 save controls). */
  headerActions?: ReactNode;
  /** Connected-editors presence indicator (e.g. <CollabPresence>), shown left of
   *  headerActions in the back-link row. Renders nothing when collab is off or
   *  the operator is alone, so the shell stays collab-agnostic. */
  presence?: ReactNode;
  /** The two columns: main `<section>` + rail `<aside>`. */
  children: ReactNode;
  /** Contents of the sticky bottom action bar. */
  actionBar: ReactNode;
}

/**
 * Shared page chrome for the run-editor pages (/hitl2, /edit, /regenerate):
 * the back-link row, SectionHead, task brief, the two-column grid, and the
 * sticky bottom action bar. Page-specific state stays in each page.
 */
export function RunEditorShell({
  runId,
  run,
  kicker,
  hed,
  dek,
  headerActions,
  presence,
  children,
  actionBar,
}: RunEditorShellProps) {
  const shortId = runId.slice(0, 8);

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 pb-32">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link
          href={`/runs/${runId}`}
          className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider"
        >
          ← Run · {shortId}
        </Link>
        {(presence || headerActions) && (
          <div className="flex items-center gap-3">
            {presence}
            {headerActions}
          </div>
        )}
      </div>

      <SectionHead kicker={kicker} hed={hed} dek={dek} />

      {run && <RunTaskDetails run={run} />}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">{children}</div>

      {/* Sticky action bar — fixed h-16 (4rem) so the rail's
          max-h-[calc(100vh-4rem)] aligns to it pixel-perfect. */}
      <div className="fixed bottom-0 inset-x-0 h-16 bg-paper/95 backdrop-blur border-t border-ink z-40">
        <div className="mx-auto max-w-[1180px] h-full px-5 md:px-10 flex items-center justify-end gap-3">
          {actionBar}
        </div>
      </div>
    </div>
  );
}
