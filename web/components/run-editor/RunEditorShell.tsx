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
  children,
  actionBar,
}: RunEditorShellProps) {
  const shortId = runId.slice(0, 8);

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 pb-32">
      {headerActions ? (
        <div className="mb-4 flex items-center justify-between gap-3">
          <Link
            href={`/runs/${runId}`}
            className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider"
          >
            ← Run · {shortId}
          </Link>
          {headerActions}
        </div>
      ) : (
        <div className="mb-4">
          <Link
            href={`/runs/${runId}`}
            className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider"
          >
            ← Run · {shortId}
          </Link>
        </div>
      )}

      <SectionHead kicker={kicker} hed={hed} dek={dek} />

      {run && <RunTaskDetails run={run} />}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">{children}</div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 bg-paper/95 backdrop-blur border-t border-ink z-40">
        <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-3 flex items-center justify-end gap-3">
          {actionBar}
        </div>
      </div>
    </div>
  );
}
