import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { MeResponse } from "@/lib/types";

// Mock the API layer so /me resolves/rejects deterministically per test.
const mockGetMe = vi.fn<() => Promise<MeResponse>>();
vi.mock("@/lib/api", () => ({
  meApi: { get: () => mockGetMe() },
}));

import { useRole } from "@/lib/use-role";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  mockGetMe.mockReset();
});

describe("useRole", () => {
  it("exposes the role from /me and gates capabilities by rank", async () => {
    mockGetMe.mockResolvedValue({ email: "rev@bowtie.com.hk", role: "reviewer" });
    const { result } = renderHook(() => useRole(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.role).toBe("reviewer"));
    expect(result.current.email).toBe("rev@bowtie.com.hk");
    // reviewer can publish + create, cannot edit prompts (admin)
    expect(result.current.can("publish")).toBe(true);
    expect(result.current.can("create_run")).toBe(true);
    expect(result.current.can("edit_prompts")).toBe(false);
    expect(result.current.isDevFallback).toBe(false);
  });

  it("a viewer cannot create, approve, or publish", async () => {
    mockGetMe.mockResolvedValue({ email: "v@bowtie.com.hk", role: "viewer" });
    const { result } = renderHook(() => useRole(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.role).toBe("viewer"));
    expect(result.current.can("read")).toBe(true);
    expect(result.current.can("create_run")).toBe(false);
    expect(result.current.can("hitl2_decide")).toBe(false);
    expect(result.current.can("publish")).toBe(false);
  });

  it("an author can create runs but cannot approve/publish", async () => {
    mockGetMe.mockResolvedValue({ email: "a@bowtie.com.hk", role: "author" });
    const { result } = renderHook(() => useRole(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.role).toBe("author"));
    expect(result.current.can("create_run")).toBe(true);
    expect(result.current.can("promote_topics")).toBe(true);
    expect(result.current.can("hitl1_approve")).toBe(false);
    expect(result.current.can("publish")).toBe(false);
  });

  it("an admin can do everything including managing users", async () => {
    mockGetMe.mockResolvedValue({ email: "ad@bowtie.com.hk", role: "admin" });
    const { result } = renderHook(() => useRole(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.role).toBe("admin"));
    expect(result.current.can("publish")).toBe(true);
    expect(result.current.can("edit_prompts")).toBe(true);
    expect(result.current.can("manage_users")).toBe(true);
  });

  it("falls back to full-access admin when /me is unavailable (dev backend)", async () => {
    mockGetMe.mockRejectedValue(new Error("404: Not Found"));
    const { result } = renderHook(() => useRole(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isDevFallback).toBe(true));
    expect(result.current.role).toBe("admin");
    expect(result.current.can("manage_users")).toBe(true);
    expect(result.current.can("publish")).toBe(true);
  });
});
