"use client";
import { toast } from "sonner";

import { cmsKindName } from "@/lib/cms-kind-helpers";
import type { DryPublishResponse, PublishTargetKind } from "@/lib/types";

interface WpPayloadViewProps {
  /** The dry-publish preview, or null before the first build. */
  payload: DryPublishResponse | null;
  isPending: boolean;
  isError: boolean;
  errorMessage?: string;
  /** Rebuild the preview from the current edits. */
  onRefresh: () => void;
  /** False while there is nothing to preview (e.g. no render yet). */
  canRefresh: boolean;
  /** CMS kind for the heading label; defaults to WordPress. */
  kind?: PublishTargetKind;
}

/**
 * Read-only preview of the exact WordPress REST request that a publish / re-push
 * would send (target, method, URL, headers, body). Shared by the HITL_2 review
 * gate and the filed-run edit page.
 */
export function WpPayloadView({
  payload,
  isPending,
  isError,
  errorMessage,
  onRefresh,
  canRefresh,
  kind,
}: WpPayloadViewProps) {
  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <p className="kicker">{cmsKindName(kind ?? "wordpress")} REST payload</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onRefresh}
            disabled={!canRefresh || isPending}
            className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider disabled:opacity-50"
          >
            {isPending ? "↻ Building…" : "↻ Refresh"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!payload) return;
              navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
              toast.success("Copied payload");
            }}
            disabled={!payload}
            className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider disabled:opacity-50"
          >
            ⧉ Copy
          </button>
        </div>
      </div>
      {isPending && (
        <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider animate-pulse">
          Building payload…
        </p>
      )}
      {isError && (
        <p className="font-mono text-[12px] text-accent-deep">
          Failed to build payload — {errorMessage}
        </p>
      )}
      {payload && (
        <div className="space-y-4">
          {payload.validation_error && (
            <p
              role="alert"
              className="border border-accent-deep/40 bg-accent-deep/5 text-accent-deep rounded p-3 text-[12px]"
            >
              ⚠ {payload.validation_error}
            </p>
          )}
          <div className="space-y-1 text-[13px]">
            <p>
              <span className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">
                Target ·
              </span>{" "}
              <span className="font-mono">{payload.target_label}</span>{" "}
              <span className="text-ink-faint">({payload.target_base_url})</span>
            </p>
            <p>
              <span className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">
                Request ·
              </span>{" "}
              <span className="font-mono">
                {payload.request_method} {payload.request_url}
              </span>
            </p>
          </div>
          <div>
            <p className="kicker mb-1">Headers</p>
            <pre className="border border-rule bg-paper rounded p-3 text-[12px] font-mono text-ink overflow-x-auto">
              {JSON.stringify(payload.request_headers, null, 2)}
            </pre>
          </div>
          <div>
            <p className="kicker mb-1">Body</p>
            <pre className="border border-rule bg-paper rounded p-3 text-[12px] font-mono text-ink whitespace-pre-wrap break-words overflow-x-auto max-h-[60vh]">
              {JSON.stringify(payload.request_body, null, 2)}
            </pre>
          </div>
        </div>
      )}
      {!payload && !isPending && !isError && (
        <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">
          Switch to this tab to preview the payload.
        </p>
      )}
    </>
  );
}
