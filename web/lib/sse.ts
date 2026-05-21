"use client";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { useEffect, useRef, useState } from "react";

import type { SseEvent } from "./types";

export function useRunEvents(runId: string | null) {
  const [events, setEvents] = useState<SseEvent[]>([]);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!runId) return;
    ctrl.current = new AbortController();
    fetchEventSource(`/api/runs/${runId}/events`, {
      signal: ctrl.current.signal,
      onmessage(ev) {
        try {
          const parsed: SseEvent = JSON.parse(ev.data);
          setEvents((prev) => [...prev, parsed]);
        } catch {
          // ignore malformed events
        }
      },
      onerror(err) {
        console.warn("SSE error", err);
        throw err; // back off and retry
      },
    });
    return () => ctrl.current?.abort();
  }, [runId]);

  return events;
}
