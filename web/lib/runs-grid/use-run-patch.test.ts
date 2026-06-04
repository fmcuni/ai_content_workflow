import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Render, RunSummary } from "@/lib/types";

// Mock the API + toast so the mutation resolves/rejects deterministically.
const mockPatchRun = vi.fn<(runId: string, body: unknown) => Promise<{ ok: boolean; version: number | null }>>();
const mockToastError = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    patchRun: (runId: string, body: unknown) => mockPatchRun(runId, body),
    listRuns: () => Promise.resolve([]),
  },
}));
vi.mock("sonner", () => ({ toast: { error: (m: string) => mockToastError(m) } }));

import { useRunPatch } from "@/lib/runs-grid/use-run-patch";

const ENCODED_SLUG = "%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85";

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "r1",
    status: "persisted",
    topic: "Topic",
    article_url: "",
    mode: "auto",
    created_at: "2026-06-04T00:00:00Z",
    chosen_route: null,
    iteration_count: 0,
    wp_author_id: 3,
    wp_publish_status: "draft",
    ...overrides,
  };
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  mockPatchRun.mockReset();
  mockToastError.mockReset();
});

describe("useRunPatch", () => {
  it("optimistically applies the patch to the ['runs'] cache", async () => {
    const qc = makeClient();
    qc.setQueryData<RunSummary[]>(["runs"], [makeRun()]);
    mockPatchRun.mockResolvedValue({ ok: true, version: 1 });

    const { result } = renderHook(() => useRunPatch(), { wrapper: wrapper(qc) });
    act(() => result.current.patch("r1", { wp_author_id: 7, wp_publish_status: "publish" }));

    // The patched values can only come from the optimistic write — the server
    // mock returns {ok,version}, never a run row.
    await waitFor(() => {
      const optimistic = qc.getQueryData<RunSummary[]>(["runs"]);
      expect(optimistic?.[0].wp_author_id).toBe(7);
      expect(optimistic?.[0].wp_publish_status).toBe("publish");
    });
    expect(mockPatchRun).toHaveBeenCalledTimes(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("canonicalizes an inline slug edit for the optimistic value", async () => {
    const qc = makeClient();
    qc.setQueryData<RunSummary[]>(["runs"], [makeRun()]);
    mockPatchRun.mockResolvedValue({ ok: true, version: 1 });

    const { result } = renderHook(() => useRunPatch(), { wrapper: wrapper(qc) });
    act(() => result.current.patch("r1", { wp_slug: "手足口病" }));

    await waitFor(() =>
      expect(qc.getQueryData<RunSummary[]>(["runs"])?.[0].wp_slug).toBe(ENCODED_SLUG),
    );
    expect(mockPatchRun).toHaveBeenCalled();
  });

  it("rolls back and shows a stale-version toast on 409", async () => {
    const qc = makeClient();
    qc.setQueryData<RunSummary[]>(["runs"], [makeRun({ wp_author_id: 3 })]);
    mockPatchRun.mockRejectedValue(
      new Error('409: {"detail":{"error":"stale_version","current_version":1}}'),
    );

    const { result } = renderHook(() => useRunPatch(), { wrapper: wrapper(qc) });
    act(() => result.current.patch("r1", { wp_author_id: 99 }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    // Rolled back to the pre-edit value.
    expect(qc.getQueryData<RunSummary[]>(["runs"])?.[0].wp_author_id).toBe(3);
    expect(mockToastError.mock.calls[0][0]).toMatch(/changed since/i);
  });

  it("sends the cached render version as expected_version and refreshes it on success", async () => {
    const qc = makeClient();
    qc.setQueryData<RunSummary[]>(["runs"], [makeRun()]);
    qc.setQueryData<Render>(["run-render", "r1"], {
      seo_title: "t", meta_description: "m", html_body: "<p/>",
      faq_schema_jsonld: null, excerpt_suggestion: "", slug_suggestion: "", version: 5,
    });
    mockPatchRun.mockResolvedValue({ ok: true, version: 6 });

    const { result } = renderHook(() => useRunPatch(), { wrapper: wrapper(qc) });
    act(() => result.current.patch("r1", { acf_adv_id: 2 }));

    await waitFor(() => expect(mockPatchRun).toHaveBeenCalled());
    expect(mockPatchRun.mock.calls[0][1]).toMatchObject({ acf_adv_id: 2, expected_version: 5 });
    // Cached render version advances so a second edit doesn't 409 against itself.
    await waitFor(() => expect(qc.getQueryData<Render>(["run-render", "r1"])?.version).toBe(6));
  });

  it("omits expected_version when no render is cached (last-write-wins)", async () => {
    const qc = makeClient();
    qc.setQueryData<RunSummary[]>(["runs"], [makeRun()]);
    mockPatchRun.mockResolvedValue({ ok: true, version: null });

    const { result } = renderHook(() => useRunPatch(), { wrapper: wrapper(qc) });
    act(() => result.current.patch("r1", { acf_widget_id: 9 }));

    await waitFor(() => expect(mockPatchRun).toHaveBeenCalled());
    expect(mockPatchRun.mock.calls[0][1]).not.toHaveProperty("expected_version");
  });
});
