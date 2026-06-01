"use client";
import * as React from "react";

import { ThoughtMarkdown } from "@/components/ThoughtMarkdown";
import type { SseEvent } from "@/lib/types";

interface Burst {
  agent: string;
  startedAt: string;
  text: string;
}

// Walk the event stream and accumulate contiguous thought chunks per agent
// into "bursts". A burst ends when either (a) the agent changes or (b) any
// non-thinking milestone event arrives in between — which is how we tell that
// the writer iterated (writer → audit → writer) and started a fresh pass.
function collectBursts(events: SseEvent[]): Burst[] {
  const bursts: Burst[] = [];
  let interrupted = true;
  for (const e of events) {
    const isThought = e.event.endsWith(".thinking");
    if (!isThought) {
      interrupted = true;
      continue;
    }
    const chunk = (e.payload?.chunk as string | undefined) ?? "";
    if (!chunk) continue;
    const agent =
      (e.payload?.agent as string | undefined) ?? e.event.replace(/\.thinking$/, "");
    const head = bursts[bursts.length - 1];
    if (!interrupted && head && head.agent === agent) {
      head.text += chunk;
    } else {
      bursts.push({ agent, startedAt: e.timestamp, text: chunk });
    }
    interrupted = false;
  }
  return bursts;
}

const AGENT_LABEL: Record<string, string> = {
  writer: "Writer",
  audit: "Audit",
  gap_analysis: "Gap analysis",
  outline: "Outline",
  resolve_citations: "Citations",
};

function formatTime(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function ThinkingStream({
  events,
  live,
}: {
  events: SseEvent[];
  // status === "production" → live; show pulsing cursor and auto-scroll.
  // After drafting completes the panel stays visible (collapsed by default
  // via the toggle) so reviewers can revisit what the model reasoned about.
  live: boolean;
}) {
  const bursts = React.useMemo(() => collectBursts(events), [events]);
  const [open, setOpen] = React.useState(true);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  // Track whether the user is "pinned" to the bottom. Default true so the
  // first chunks scroll into view; flip to false the moment the user scrolls
  // up to read, and back to true if they return to the bottom. This is the
  // standard chat / log-tail UX — never yank the reader off mid-sentence.
  const pinned = React.useRef(true);
  const totalLen = bursts.reduce((n, b) => n + b.text.length, 0);

  const onScroll = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = distanceFromBottom < 32;
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el) return;
    if (pinned.current) {
      // rAF lets the just-appended chunk lay out before we measure scrollHeight.
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [totalLen, bursts.length, open]);

  if (bursts.length === 0 && !live) return null;

  return (
    <section className="mb-8 border border-rule rounded-md bg-paper">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="kicker">Model thinking</span>
          {live && (
            <span
              aria-hidden
              className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
            />
          )}
          <span className="font-mono text-[11px] text-ink-faint">
            {bursts.length === 0
              ? "waiting…"
              : `${bursts.length} ${bursts.length === 1 ? "burst" : "bursts"}`}
          </span>
        </span>
        <span className="font-mono text-[11px] text-ink-faint">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div
          ref={containerRef}
          onScroll={onScroll}
          className="border-t border-rule max-h-[420px] overflow-y-auto"
        >
          {bursts.length === 0 ? (
            <p className="px-4 py-6 font-display italic text-[14px] text-ink-faint">
              The model hasn&apos;t spoken yet…
            </p>
          ) : (
            <ol className="divide-y divide-rule">
              {bursts.map((b, i) => (
                <li key={i} className="px-4 py-3">
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-accent">
                      {AGENT_LABEL[b.agent] ?? b.agent}
                    </span>
                    <span className="font-mono text-[11px] text-ink-faint tabular-nums">
                      {formatTime(b.startedAt)}
                    </span>
                  </div>
                  <ThoughtMarkdown
                    text={b.text}
                    className="font-display text-[14px] leading-relaxed text-ink-soft"
                  />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
