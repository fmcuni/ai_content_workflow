import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Hitl2Snapshot, RunDraft } from "@/lib/types";

// Mock the API client so no network call is made.
const listHitl2Snapshots = vi.fn();
const listRunDrafts = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    listHitl2Snapshots: (...args: unknown[]) => listHitl2Snapshots(...args),
    listRunDrafts: (...args: unknown[]) => listRunDrafts(...args),
  },
}));

import { Hitl2VersionHistory } from "@/components/Hitl2VersionHistory";

function snap(over: Partial<Hitl2Snapshot> = {}): Hitl2Snapshot {
  return {
    snapshot_id: over.snapshot_id ?? "snap-1",
    created_at: over.created_at ?? "2026-06-09T10:00:00Z",
    created_by: over.created_by ?? "ed@bowtie.com.hk",
    trigger: over.trigger ?? "manual",
    html_body: over.html_body ?? "<p>body</p>",
    version_number: over.version_number,
    is_current: over.is_current,
    ...over,
  };
}

function draft(over: Partial<RunDraft> = {}): RunDraft {
  return {
    draft_id: over.draft_id ?? "draft-1",
    iteration: over.iteration ?? 1,
    created_at: over.created_at ?? "2026-06-09T09:00:00Z",
    html_body: over.html_body ?? "<p>ai draft</p>",
    seo_title: over.seo_title ?? "title",
    meta_description: over.meta_description ?? "meta",
  };
}

function renderPanel(snapshots: Hitl2Snapshot[], drafts: RunDraft[] = []) {
  listHitl2Snapshots.mockResolvedValue(snapshots);
  listRunDrafts.mockResolvedValue(drafts);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Hitl2VersionHistory
        runId="run-1"
        open
        onOpenChange={() => {}}
        onRestore={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("Hitl2VersionHistory", () => {
  it("renders the version number and the ● Live badge on the current snapshot", async () => {
    renderPanel([
      snap({ snapshot_id: "live", version_number: 2, is_current: true }),
      snap({
        snapshot_id: "base",
        version_number: 1,
        is_current: false,
        trigger: "generated",
      }),
    ]);

    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());
    expect(screen.getByText("v1")).toBeInTheDocument();
    // The "● Live" badge marks the current entry exactly once.
    expect(screen.getByLabelText("Currently live version")).toBeInTheDocument();
    // The generated baseline carries its distinct label.
    expect(screen.getByText("AI · original draft")).toBeInTheDocument();
  });

  it("shows the empty state only when there are no versions", async () => {
    renderPanel([]);
    await waitFor(() =>
      expect(screen.getByText("No saved versions yet.")).toBeInTheDocument(),
    );
  });

  it("interleaves AI draft iterations with snapshots in one timeline", async () => {
    renderPanel(
      [snap({ snapshot_id: "rev", created_at: "2026-06-09T11:00:00Z", html_body: "<p>edited</p>" })],
      [draft({ draft_id: "d2", iteration: 2, created_at: "2026-06-09T10:00:00Z", html_body: "<p>v2</p>" })],
    );

    // The draft iteration shows as its own AI row.
    await waitFor(() => expect(screen.getByText("AI · draft #2")).toBeInTheDocument());
    // Two entries → v2 (newest snapshot) over v1 (older draft).
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
  });

  it("drops a draft whose body is already captured by a snapshot", async () => {
    renderPanel(
      [snap({ snapshot_id: "gen", trigger: "generated", html_body: "<p>same</p>", is_current: true })],
      [draft({ draft_id: "d1", iteration: 1, html_body: "<p>same</p>" })],
    );

    // Only the snapshot row remains (no duplicate AI draft row for the same body).
    await waitFor(() => expect(screen.getByText("AI · original draft")).toBeInTheDocument());
    expect(screen.queryByText("AI · draft #1")).not.toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.queryByText("v2")).not.toBeInTheDocument();
  });
});
