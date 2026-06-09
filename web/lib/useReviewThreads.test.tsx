import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewThread } from "@/lib/types";

// Mock the API so create resolves/rejects deterministically.
const mockCreate = vi.fn<(runId: string, body: unknown) => Promise<ReviewThread>>();
vi.mock("@/lib/api", () => ({
  api: {
    listReviewThreads: () => Promise.resolve([]),
    createReviewThread: (runId: string, body: unknown) => mockCreate(runId, body),
    replyReviewThread: () => Promise.resolve({} as ReviewThread),
    resolveReviewThread: () => Promise.resolve({} as ReviewThread),
    deleteReviewThread: () => Promise.resolve(),
  },
}));

import { useReviewThreads } from "@/lib/useReviewThreads";

function makeThread(): ReviewThread {
  return {
    thread_id: "t-1",
    run_id: "run-1",
    anchor_id: "r-1",
    anchor_text: "lede",
    status: "open",
    messages: [],
    created_by: "a@b.com",
    created_by_name: "A",
    created_at: "2026-06-09T00:00:00Z",
    resolved_by: null,
    resolved_by_name: null,
    resolved_at: null,
    updated_at: "2026-06-09T00:00:00Z",
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

const identity = { email: "a@b.com", name: "A" };

beforeEach(() => {
  mockCreate.mockReset();
});

describe("useReviewThreads — pending composer lifecycle", () => {
  it("keeps the pending note when the create POST fails (so it isn't silently lost)", async () => {
    mockCreate.mockRejectedValue(new Error("500"));
    const setHtml = vi.fn();
    const { result } = renderHook(() => useReviewThreads("run-1", identity, setHtml), {
      wrapper: wrapper(makeClient()),
    });

    act(() => result.current.beginThread("r-1", "lede"));
    expect(result.current.pending).not.toBeNull();

    act(() => result.current.submitPending("needs a citation"));

    // The mutation fails, but the composer (pending) MUST stay so the operator
    // can retry — the old code cleared it synchronously and dropped the note.
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    expect(result.current.pending).not.toBeNull();
  });

  it("clears the pending note only after the create POST succeeds", async () => {
    mockCreate.mockResolvedValue(makeThread());
    const setHtml = vi.fn();
    const { result } = renderHook(() => useReviewThreads("run-1", identity, setHtml), {
      wrapper: wrapper(makeClient()),
    });

    act(() => result.current.beginThread("r-1", "lede"));
    act(() => result.current.submitPending("needs a citation"));

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    expect(result.current.pending).toBeNull();
    expect(result.current.focusedThreadId).toBe("t-1");
  });
});
