import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardRecord } from "@/lib/runs-grid/board-record";
import type { RunStatus, RunSummary } from "@/lib/types";

// Mock the per-run API + toast so the fan-out resolves/rejects deterministically.
const mockResumeHitl2 = vi.fn<(runId: string, body: unknown) => Promise<unknown>>();
const mockRestartRun = vi.fn<(runId: string) => Promise<unknown>>();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    resumeHitl2: (runId: string, body: unknown) => mockResumeHitl2(runId, body),
    restartRun: (runId: string) => mockRestartRun(runId),
    listRuns: () => Promise.resolve([]),
  },
  topicBatchesApi: { delete: () => Promise.resolve({ ok: true }) },
}));
vi.mock("sonner", () => ({
  toast: { success: (m: string) => mockToastSuccess(m), error: (m: string) => mockToastError(m) },
}));

import {
  eligibleRuns,
  fanOut,
  planRunAction,
  useBulkActions,
  visibleRunIds,
} from "@/lib/runs-grid/use-bulk-actions";

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "r1",
    status: "hitl_2",
    topic: "Topic",
    article_url: "",
    mode: "auto",
    created_at: "2026-06-04T00:00:00Z",
    chosen_route: null,
    iteration_count: 0,
    wp_publish_status: "draft",
    ...overrides,
  };
}

describe("eligibleRuns", () => {
  const runs = [
    makeRun({ run_id: "a", status: "hitl_1" }),
    makeRun({ run_id: "b", status: "hitl_2" }),
    makeRun({ run_id: "c", status: "persisted" }),
    makeRun({ run_id: "d", status: "published" }),
    makeRun({ run_id: "e", status: "failed" }),
    makeRun({ run_id: "f", status: "production" }),
  ];

  it("approve targets only HITL_1 runs", () => {
    expect(eligibleRuns("approve", runs).map((r) => r.run_id)).toEqual(["a"]);
  });
  it("publish targets only HITL_2 runs", () => {
    expect(eligibleRuns("publish", runs).map((r) => r.run_id)).toEqual(["b"]);
  });
  it("republish targets persisted + published runs", () => {
    expect(eligibleRuns("republish", runs).map((r) => r.run_id)).toEqual(["c", "d"]);
  });
  it("restart targets only failed runs", () => {
    expect(eligibleRuns("restart", runs).map((r) => r.run_id)).toEqual(["e"]);
  });
  it("assign + delete accept every selected run", () => {
    expect(eligibleRuns("assign_author", runs)).toHaveLength(runs.length);
    expect(eligibleRuns("assign_category", runs)).toHaveLength(runs.length);
    expect(eligibleRuns("delete", runs)).toHaveLength(runs.length);
  });
});

describe("planRunAction", () => {
  it("reports the skipped count for ineligible rows (no silent truncation)", () => {
    const selected = [
      makeRun({ run_id: "a", status: "hitl_1" }),
      makeRun({ run_id: "b", status: "production" }),
      makeRun({ run_id: "c", status: "hitl_2" }),
    ];
    const plan = planRunAction("approve", selected);
    expect(plan.eligible.map((r) => r.run_id)).toEqual(["a"]);
    expect(plan.skipped).toBe(2); // production + hitl_2 skipped
  });

  it("detects live publish targets among the eligible runs", () => {
    const selected = [
      makeRun({ run_id: "a", status: "hitl_2", wp_publish_status: "publish" }),
      makeRun({ run_id: "b", status: "hitl_2", wp_publish_status: "draft" }),
      makeRun({ run_id: "c", status: "hitl_2", wp_publish_status: "publish" }),
      // A live-status run that's NOT at HITL_2 must not count — it's ineligible.
      makeRun({ run_id: "d", status: "production", wp_publish_status: "publish" }),
    ];
    const plan = planRunAction("publish", selected);
    expect(plan.eligible).toHaveLength(3);
    expect(plan.live).toBe(2);
    expect(plan.skipped).toBe(1);
  });
});

describe("visibleRunIds", () => {
  const records: BoardRecord[] = [
    { kind: "run", id: "r1", createdAt: "", group: "review", voice: "", run: makeRun({ run_id: "r1" }) },
    { kind: "batch", id: "b1", createdAt: "", group: "review", voice: "", batch: {} as never },
    { kind: "run", id: "r2", createdAt: "", group: "generating", voice: "", run: makeRun({ run_id: "r2" }) },
  ];

  it("includes top-level runs but not batches", () => {
    expect(visibleRunIds(records, new Set(), () => [])).toEqual(["r1", "r2"]);
  });

  it("includes the promoted children of an expanded batch only", () => {
    const childIdsOf = (id: string) => (id === "b1" ? ["c1", "c2"] : []);
    expect(visibleRunIds(records, new Set(["b1"]), childIdsOf)).toEqual(["r1", "c1", "c2", "r2"]);
  });

  it("dedupes ids shared between a flat row and a batch child", () => {
    const childIdsOf = () => ["r1"]; // child already present as a top-level row
    expect(visibleRunIds(records, new Set(["b1"]), childIdsOf)).toEqual(["r1", "r2"]);
  });
});

describe("fanOut", () => {
  it("runs items strictly sequentially in order", async () => {
    const order: string[] = [];
    await fanOut(["a", "b", "c"], async (id) => {
      order.push(`start:${id}`);
      await Promise.resolve();
      order.push(`end:${id}`);
    });
    // Sequential = each item fully ends before the next starts.
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("aggregates successes + failures without aborting on a rejection", async () => {
    const summary = await fanOut(["a", "bad", "c"], async (id) => {
      if (id === "bad") throw new Error("boom");
    });
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.firstError).toBe("boom");
  });
});

// ── hook path ───────────────────────────────────────────────────────────────
function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  mockResumeHitl2.mockReset();
  mockRestartRun.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

describe("useBulkActions", () => {
  it("fans publish out over the single-publish path and reports a success summary", async () => {
    mockResumeHitl2.mockResolvedValue({ ok: true });
    const qc = makeClient();
    const runs = [
      makeRun({ run_id: "a", status: "hitl_2" }),
      makeRun({ run_id: "b", status: "hitl_2" }),
    ];

    const { result } = renderHook(() => useBulkActions(), { wrapper: wrapper(qc) });
    act(() => result.current.execute({ action: "publish", runs }));

    await waitFor(() => expect(mockResumeHitl2).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Published 2"));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("reports a failure count in the summary toast when a row errors", async () => {
    mockRestartRun.mockImplementation((id: string) =>
      id === "b" ? Promise.reject(new Error("nope")) : Promise.resolve({ ok: true }),
    );
    const qc = makeClient();
    const runs = [
      makeRun({ run_id: "a", status: "failed" }),
      makeRun({ run_id: "b", status: "failed" }),
    ];

    const { result } = renderHook(() => useBulkActions(), { wrapper: wrapper(qc) });
    act(() => result.current.execute({ action: "restart", runs }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockToastError.mock.calls[0][0]).toMatch(/Restarted 1 · 1 failed — nope/);
  });
});

// Type-only guard so RunStatus stays the source of truth for these literals.
const _statuses: RunStatus[] = ["hitl_1", "hitl_2", "persisted", "published", "failed"];
void _statuses;
