import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Hitl2Snapshot, Hitl2SnapshotIn } from "@/lib/types";

// Mock the API so we can assert exactly whether a body write was attempted.
const mockSave = vi.fn<(runId: string, body: unknown) => Promise<Hitl2Snapshot>>();
vi.mock("@/lib/api", () => ({
  api: {
    saveHitl2Snapshot: (runId: string, body: unknown) => mockSave(runId, body),
    beaconHitl2Snapshot: vi.fn(),
    listHitl2Snapshots: () => Promise.resolve([]),
  },
}));

import { snapshotKey } from "@/lib/run-editor/form";
import { useSnapshotAutosave, type SnapshotAutosave } from "@/lib/run-editor/useSnapshotAutosave";

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

function makeSnapshotIn(html: string): Hitl2SnapshotIn {
  return {
    trigger: "manual",
    html_body: html,
    committed_html_body: null,
    seo_title: null,
    meta_description: null,
    notes: null,
    comments: [],
    wp_publish_status: "draft",
    wp_author_id: null,
    wp_category_ids: null,
    wp_tag_ids: null,
    wp_featured_media_id: null,
    wp_slug: null,
    wp_excerpt: null,
    wp_publish_at: null,
  };
}

interface RenderArgs {
  collabActive?: boolean;
  flattenBody?: () => string;
  snapshotIn: Hitl2SnapshotIn;
  baselineKey: string | null;
}

function renderAutosave({ collabActive, flattenBody, snapshotIn, baselineKey }: RenderArgs) {
  const editorEmailRef = { current: "editor@bowtie.com.hk" };
  const submittedRef = { current: false };
  const hydratedFromSnapshotRef = { current: false };
  return renderHook<SnapshotAutosave, void>(
    () =>
      useSnapshotAutosave({
        runId: "run-1",
        ready: true,
        snapshotIn,
        baselineKey,
        editorEmailRef,
        submittedRef,
        hydrateEnabled: false,
        hydratedFromSnapshotRef,
        onHydrate: () => {},
        collabActive,
        flattenBody,
      }),
    { wrapper: wrapper(makeClient()) },
  );
}

beforeEach(() => {
  mockSave.mockReset();
  mockSave.mockResolvedValue({} as Hitl2Snapshot);
});

describe("useSnapshotAutosave — collab gating", () => {
  it("does NOT persist a body write when collabActive is true", async () => {
    // A clean baseline + a dirty live snapshot — without the collab gate this
    // would POST. With collabActive it must short-circuit to "unchanged".
    const baseline = makeSnapshotIn("<p>seed</p>");
    const dirty = makeSnapshotIn("<p>seed edited by a peer</p>");
    const { result } = renderAutosave({
      collabActive: true,
      snapshotIn: dirty,
      baselineKey: snapshotKey(baseline),
    });

    await waitFor(() => expect(result.current).toBeTruthy());
    const outcome = await result.current.saveSnapshot("manual");

    expect(outcome).toBe("unchanged");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("persists the FLATTENED working body but PRESERVES the committed baseline under collab", async () => {
    // The live React `snapshotIn.html_body` is stale; the flatten source is the
    // truth for the WORKING body. But `committed_html_body` (the tracked-changes
    // baseline) is NOT in Yjs, so it must survive from the React snapshot —
    // overwriting it with the flattened working body collapses every pending
    // tracked change, so they vanish on the next reload (the bug this guards).
    const baseline = makeSnapshotIn("<p>seed</p>");
    const stale: Hitl2SnapshotIn = {
      ...makeSnapshotIn("<p>stale react state</p>"),
      committed_html_body: "<p>committed baseline</p>",
    };
    const { result } = renderAutosave({
      collabActive: true,
      flattenBody: () => "<p>flattened from doc</p>",
      snapshotIn: stale,
      baselineKey: snapshotKey(baseline),
    });

    // The baseline-init effect must run so `lastSavedKey` is set (non-null).
    await waitFor(() => expect(result.current.isDirty).toBe(true));
    const outcome = await result.current.saveSnapshot("manual");

    expect(outcome).toBe("saved");
    expect(mockSave).toHaveBeenCalledTimes(1);
    const [, body] = mockSave.mock.calls[0]!;
    expect(body).toMatchObject({
      html_body: "<p>flattened from doc</p>",
      committed_html_body: "<p>committed baseline</p>",
      trigger: "manual",
    });
  });

  it("persists a dirty body write when collab is off (existing behaviour preserved)", async () => {
    const baseline = makeSnapshotIn("<p>seed</p>");
    const dirty = makeSnapshotIn("<p>seed edited</p>");
    const { result } = renderAutosave({
      snapshotIn: dirty,
      baselineKey: snapshotKey(baseline),
    });

    // The baseline-init effect must run so `lastSavedKey` is set (non-null) and
    // the live snapshot reads as dirty.
    await waitFor(() => expect(result.current.isDirty).toBe(true));
    const outcome = await result.current.saveSnapshot("manual");

    expect(outcome).toBe("saved");
    expect(mockSave).toHaveBeenCalledTimes(1);
    const [runId, body] = mockSave.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(body).toMatchObject({ html_body: "<p>seed edited</p>", trigger: "manual" });
  });
});
