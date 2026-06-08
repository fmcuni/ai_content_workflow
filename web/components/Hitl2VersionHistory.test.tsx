import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Hitl2Snapshot } from "@/lib/types";

// Mock the API client so no network call is made.
const listHitl2Snapshots = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { listHitl2Snapshots: (...args: unknown[]) => listHitl2Snapshots(...args) },
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

function renderPanel(data: Hitl2Snapshot[]) {
  listHitl2Snapshots.mockResolvedValue(data);
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
});
