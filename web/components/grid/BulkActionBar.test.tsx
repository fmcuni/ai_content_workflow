import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type Role, roleMeetsRequirement } from "@/lib/roles";
import type { RunSummary } from "@/lib/types";

// Pin the operator role so RoleGate (inside the bar) shows/hides buttons by role.
const mockUseRole = vi.fn();
vi.mock("@/lib/use-role", () => ({ useRole: () => mockUseRole() }));
// The bulk hook reaches the API only on click; stub the modules so import works.
vi.mock("@/lib/api", () => ({ api: {}, topicBatchesApi: {} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BulkActionBar } from "@/components/grid/BulkActionBar";

function setRole(role: Role) {
  mockUseRole.mockReturnValue({
    role,
    email: `${role}@bowtie.com.hk`,
    isLoading: false,
    isDevFallback: false,
    can: (required: string) => roleMeetsRequirement(role, required as Role),
  });
}

function makeRun(): RunSummary {
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
  };
}

function renderBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return render(
    <BulkActionBar
      selected={new Set(["r1"])}
      runsById={new Map([["r1", makeRun()]])}
      batchesById={new Map()}
      wpUsers={new Map()}
      wpCategories={new Map()}
      onClear={() => undefined}
    />,
    { wrapper: Wrapper },
  );
}

const LIFECYCLE = ["Approve outline", "Publish", "Republish", "Assign author…", "Assign category…", "Restart failed"];

beforeEach(() => mockUseRole.mockReset());

describe("BulkActionBar role gating", () => {
  it("shows the selection count and Clear for any role", () => {
    setRole("viewer");
    renderBar();
    expect(screen.getByText("selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("hides every lifecycle action from a viewer", () => {
    setRole("viewer");
    renderBar();
    for (const label of [...LIFECYCLE, "Delete"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  it("shows lifecycle + assign actions for an editor but hides Delete (admin-only)", () => {
    setRole("editor");
    renderBar();
    for (const label of LIFECYCLE) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("shows Delete for an admin", () => {
    setRole("admin");
    renderBar();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
