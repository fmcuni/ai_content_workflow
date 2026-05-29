import type { SseEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

function glyphFor(event: string): { ch: string; tone: "ink" | "accent" | "danger" } {
  const e = event.toLowerCase();
  if (e.includes("error") || e.includes("fail")) return { ch: "✕", tone: "danger" };
  if (e.includes("hitl") || e.includes("human") || e.includes("await")) return { ch: "▴", tone: "accent" };
  return { ch: "▪", tone: "ink" };
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function EventTimeline({ events }: { events: SseEvent[] }) {
  // *.thinking events are live-only streaming chunks (one per Gemini thought
  // summary) — they have their own dedicated UI surface and would otherwise
  // drown the timeline.
  const milestones = events.filter((e) => !e.event.endsWith(".thinking"));
  if (milestones.length === 0) {
    return <p className="text-ink-faint italic font-display text-[15px]">No signal yet.</p>;
  }
  return (
    <ol className="relative">
      {milestones.map((e, i) => {
        const { ch, tone } = glyphFor(e.event);
        const last = i === milestones.length - 1;
        return (
          <li key={i} className="grid grid-cols-[72px_16px_1fr] gap-3 items-start py-2.5 border-b border-rule last:border-b-0">
            <span className="font-mono text-[11px] text-ink-faint tabular-nums pt-[2px]">
              {formatTime(e.timestamp)}
            </span>
            <span
              className={cn(
                "text-[12px] leading-none pt-[5px]",
                tone === "danger" && "text-accent-deep",
                tone === "accent" && "text-accent",
                tone === "ink" && "text-ink-soft",
                last && "animate-pulse"
              )}
              aria-hidden
            >
              {ch}
            </span>
            <div className="min-w-0">
              <p className="font-mono text-[12px] text-ink break-words">{e.event}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
