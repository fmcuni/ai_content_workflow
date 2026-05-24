"use client";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { useEffect, useRef, useState } from "react";

import type { SseEvent } from "./types";

// Next.js rewrites (`next.config.mjs` → `/api/...`) buffer the entire response
// body before forwarding it, which breaks SSE — the browser sees 200 + headers
// but zero body bytes until the upstream connection closes. Talk directly to
// the FastAPI host instead. CORS is configured for http://localhost:3000.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE;

export function useRunEvents(runId: string | null) {
  const [events, setEvents] = useState<SseEvent[]>([]);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!runId) return;
    ctrl.current = new AbortController();
    fetchEventSource(`${API_BASE}/runs/${runId}/events`, {
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
