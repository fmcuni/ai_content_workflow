import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { PublishTargetReadiness } from "@/lib/types";

// Mock the API client so no network call is made.
const readiness = vi.fn();
vi.mock("@/lib/api", () => ({
  publishTargetsApi: {
    readiness: (...args: unknown[]) => readiness(...args),
  },
}));

import { ReadinessBadge, ReadinessPanel } from "@/components/publish-targets/ReadinessPanel";

function result(over: Partial<PublishTargetReadiness> = {}): PublishTargetReadiness {
  return {
    publish_target_id: "t1",
    auth_ref: "VHIS101_WP",
    base_url: true,
    username: true,
    app_password: true,
    ready: true,
    ...over,
  };
}

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("ReadinessBadge", () => {
  it("shows 'ready' when all credential env vars are present", async () => {
    readiness.mockResolvedValue(result({ ready: true }));
    renderWithClient(<ReadinessBadge targetId="t1" />);
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
  });

  it("shows 'not set' when credentials are missing", async () => {
    readiness.mockResolvedValue(result({ ready: false, app_password: false }));
    renderWithClient(<ReadinessBadge targetId="t1" />);
    await waitFor(() => expect(screen.getByText("not set")).toBeInTheDocument());
  });
});

describe("ReadinessPanel", () => {
  it("lists the three secret names prefixed by auth_ref with set/missing state", async () => {
    readiness.mockResolvedValue(result({ ready: false, app_password: false }));
    renderWithClient(<ReadinessPanel targetId="t1" />);
    await waitFor(() =>
      expect(screen.getByText("VHIS101_WP_BASE_URL")).toBeInTheDocument(),
    );
    expect(screen.getByText("VHIS101_WP_USERNAME")).toBeInTheDocument();
    expect(screen.getByText("VHIS101_WP_APP_PASSWORD")).toBeInTheDocument();
    // Two "set" (base_url, username) + one "missing" (app_password).
    expect(screen.getAllByText("set")).toHaveLength(2);
    expect(screen.getAllByText("missing")).toHaveLength(1);
  });
});
