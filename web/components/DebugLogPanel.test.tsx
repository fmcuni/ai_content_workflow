import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RunEventLog, SseEvent } from "@/lib/types";

// Mock the API client so no network call is made. getRunLogs is the source of
// persisted rows; the component also calls it (with a high limit) on Download.
const getRunLogs = vi.fn();
const getLogs = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { getRunLogs: (...args: unknown[]) => getRunLogs(...args) },
  topicBatchesApi: { getLogs: (...args: unknown[]) => getLogs(...args) },
}));

// Mock the toast so the Download error path can be asserted without a portal.
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { DebugLogPanel } from "@/components/DebugLogPanel";

function row(over: Partial<RunEventLog> = {}): RunEventLog {
  return {
    log_id: over.log_id ?? `log-${over.seq ?? 1}`,
    stream_id: over.stream_id ?? "run-abcdef12",
    stream_kind: over.stream_kind ?? "run",
    seq: over.seq ?? 1,
    event: over.event ?? "node.start",
    level: over.level ?? "info",
    step: over.step ?? null,
    iteration: over.iteration ?? null,
    duration_ms: over.duration_ms ?? null,
    payload: over.payload ?? {},
    recorded_at: over.recorded_at ?? "2026-06-03T10:00:00.000Z",
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof DebugLogPanel>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const liveEvents: SseEvent[] = props.liveEvents ?? [];
  return render(
    <QueryClientProvider client={client}>
      <DebugLogPanel
        streamId={props.streamId ?? "run-abcdef1234567890"}
        streamKind={props.streamKind ?? "run"}
        liveEvents={liveEvents}
        isActive={props.isActive ?? false}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getRunLogs.mockReset();
  getLogs.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DebugLogPanel", () => {
  it("renders persisted rows from the run logs endpoint", async () => {
    getRunLogs.mockResolvedValue([
      row({ seq: 1, event: "outline.start", level: "info" }),
      row({ seq: 2, event: "outline.done", level: "gate" }),
    ]);

    renderPanel();

    expect(await screen.findByText("outline.start")).toBeInTheDocument();
    expect(screen.getByText("outline.done")).toBeInTheDocument();
  });

  it("hides thinking rows under the default Milestones filter and reveals them on switch", async () => {
    getRunLogs.mockResolvedValue([
      row({ seq: 1, event: "writer.start", level: "info" }),
      row({ seq: 2, event: "writer.thinking", level: "thinking" }),
    ]);

    renderPanel();

    expect(await screen.findByText("writer.start")).toBeInTheDocument();
    // Thinking row is hidden by default (Milestones).
    expect(screen.queryByText("writer.thinking")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));

    expect(await screen.findByText("writer.thinking")).toBeInTheDocument();
    // Milestone-only row no longer matches the Thinking filter.
    expect(screen.queryByText("writer.start")).not.toBeInTheDocument();
  });

  it("expands a row with a non-trivial payload to reveal pretty-printed JSON", async () => {
    getRunLogs.mockResolvedValue([
      row({ seq: 1, event: "fetch.done", level: "info", payload: { url: "https://x.test" } }),
    ]);

    renderPanel();

    const trigger = await screen.findByText("fetch.done");
    expect(screen.queryByText(/https:\/\/x\.test/)).not.toBeInTheDocument();

    fireEvent.click(trigger.closest("button") ?? trigger);

    expect(await screen.findByText(/https:\/\/x\.test/)).toBeInTheDocument();
  });

  it("Download fetches the full log with a high limit and triggers a file download", async () => {
    getRunLogs.mockResolvedValue([row({ seq: 1, event: "node.start" })]);

    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    renderPanel();
    await screen.findByText("node.start");

    getRunLogs.mockClear();
    getRunLogs.mockResolvedValue([row({ seq: 1 }), row({ seq: 2 })]);

    fireEvent.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => expect(getRunLogs).toHaveBeenCalled());
    const callArgs = getRunLogs.mock.calls[0];
    expect(callArgs[0]).toBe("run-abcdef1234567890");
    expect((callArgs[1] as { limit: number }).limit).toBeGreaterThanOrEqual(100000);
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalled();
  });

  it("the second incremental poll requests since_seq equal to the highest seq seen", async () => {
    vi.useFakeTimers();
    try {
      // First poll returns rows up to seq 5.
      getRunLogs.mockResolvedValueOnce([
        row({ seq: 4, event: "first-poll-a" }),
        row({ seq: 5, event: "first-poll-b" }),
      ]);
      // Second poll (triggered by refetchInterval) returns one newer row.
      getRunLogs.mockResolvedValueOnce([row({ seq: 6, event: "second-poll" })]);

      renderPanel({ isActive: true });

      // Drain the first poll.
      await vi.waitFor(() => expect(getRunLogs).toHaveBeenCalledTimes(1));
      // First poll has no cursor yet (since_seq undefined).
      expect((getRunLogs.mock.calls[0][1] as { since_seq?: number }).since_seq).toBeUndefined();

      // Advance past the poll interval to trigger the second fetch.
      await vi.advanceTimersByTimeAsync(3000);

      await vi.waitFor(() => expect(getRunLogs).toHaveBeenCalledTimes(2));
      // The high-water mark from the first poll (seq 5) must drive the cursor —
      // proving since_seq comes from accumulated rows, not a stale closure.
      expect((getRunLogs.mock.calls[1][1] as { since_seq?: number }).since_seq).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a toast and does not crash when Download fails", async () => {
    getRunLogs.mockResolvedValueOnce([row({ seq: 1, event: "node.start" })]);

    renderPanel();
    await screen.findByText("node.start");

    // The Download fetch rejects.
    getRunLogs.mockRejectedValueOnce(new Error("network down"));

    fireEvent.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // The button recovers (downloading reset) and the panel still renders.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /download/i })).not.toBeDisabled(),
    );
    expect(screen.getByText("node.start")).toBeInTheDocument();
  });

  it("routes batch streams through topicBatchesApi.getLogs", async () => {
    getLogs.mockResolvedValue([row({ seq: 1, event: "topic.gen", stream_kind: "batch" })]);

    renderPanel({ streamKind: "batch", streamId: "batch-99887766" });

    expect(await screen.findByText("topic.gen")).toBeInTheDocument();
    expect(getLogs).toHaveBeenCalled();
    expect(getRunLogs).not.toHaveBeenCalled();
  });
});
