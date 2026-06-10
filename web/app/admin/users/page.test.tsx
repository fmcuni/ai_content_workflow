import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { AdminUserDetail } from "@/lib/api";

// Mock the admin API so no network call is made. `vi.hoisted` makes the mock
// object available to the hoisted `vi.mock` factory without a TDZ error.
const adminUsersApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  setRole: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  remove: vi.fn(),
  revokeSessions: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ adminUsersApi }));

// Mock useRole → admin (so the page renders the management surface).
vi.mock("@/lib/use-role", () => ({
  useRole: () => ({
    role: "admin",
    email: "admin@bowtie.com.hk",
    isLoading: false,
    isDevFallback: false,
    can: () => true,
  }),
}));

import AdminUsersPage from "./page";

function user(over: Partial<AdminUserDetail> = {}): AdminUserDetail {
  return {
    id: "u1",
    email: "target@bowtie.com.hk",
    name: "Target",
    role: "viewer",
    status: "active",
    confirmed: true,
    last_sign_in_at: null,
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminUsersPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  for (const fn of Object.values(adminUsersApi)) fn.mockReset();
});

describe("AdminUsersPage", () => {
  it("lists users from adminUsersApi.list", async () => {
    adminUsersApi.list.mockResolvedValue([user()]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Target")).toBeInTheDocument());
    expect(screen.getByText("target@bowtie.com.hk")).toBeInTheDocument();
  });

  it("opens the Create user dialog and invites a new user", async () => {
    adminUsersApi.list.mockResolvedValue([]);
    adminUsersApi.create.mockResolvedValue(user({ id: "new1", email: "new@bowtie.com.hk", role: "author" }));
    renderPage();

    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(screen.getByRole("dialog", { name: "Create user" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "new@bowtie.com.hk" },
    });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "author" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() =>
      expect(adminUsersApi.create).toHaveBeenCalledWith({
        email: "new@bowtie.com.hk",
        role: "author",
      }),
    );
  });

  it("disables a user via the row action", async () => {
    adminUsersApi.list.mockResolvedValue([user()]);
    adminUsersApi.disable.mockResolvedValue(user({ status: "disabled" }));
    renderPage();

    await waitFor(() => expect(screen.getByText("Target")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() => expect(adminUsersApi.disable).toHaveBeenCalledWith("u1"));
  });

  it("revokes sessions via the row action", async () => {
    adminUsersApi.list.mockResolvedValue([user()]);
    adminUsersApi.revokeSessions.mockResolvedValue({ ok: true });
    renderPage();

    await waitFor(() => expect(screen.getByText("Target")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Revoke sessions" }));

    await waitFor(() => expect(adminUsersApi.revokeSessions).toHaveBeenCalledWith("u1"));
  });
});
