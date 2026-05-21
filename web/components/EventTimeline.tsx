import type { SseEvent } from "@/lib/types";

export function EventTimeline({ events }: { events: SseEvent[] }) {
  return (
    <ol className="space-y-2 border-l-2 border-neutral-200 pl-4">
      {events.map((e, i) => (
        <li key={i} className="text-sm">
          <span className="text-neutral-500 mr-2">{new Date(e.timestamp).toLocaleTimeString()}</span>
          <span className="font-mono">{e.event}</span>
        </li>
      ))}
    </ol>
  );
}
