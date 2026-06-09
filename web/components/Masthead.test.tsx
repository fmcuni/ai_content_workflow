import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Role } from "@/lib/roles";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const mockSignOut = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { email: "ada.lovelace@bowtie.com.hk" } } }),
  signOut: () => mockSignOut(),
}));

const toastFn = vi.fn();
vi.mock("sonner", () => ({ toast: (msg: string) => toastFn(msg) }));

const mockUseRole = vi.fn();
vi.mock("@/lib/use-role", () => ({
  useRole: () => mockUseRole(),
}));

import { Masthead } from "@/components/Masthead";

function setRole(role: Role) {
  const rank: Record<Role, number> = { viewer: 0, author: 1, reviewer: 2, admin: 3 };
  mockUseRole.mockReturnValue({
    role,
    email: `${role}@bowtie.com.hk`,
    isLoading: false,
    isDevFallback: false,
    can: (required: string) => {
      if (required === "manage_users") return rank[role] >= rank.admin;
      return true;
    },
  });
}

beforeEach(() => {
  mockUseRole.mockReset();
  mockSignOut.mockReset();
  toastFn.mockReset();
});

describe("Masthead nav role gating", () => {
  it("shows the admin Users link to admins", () => {
    setRole("admin");
    render(<Masthead />);
    const link = screen.getByRole("link", { name: "Users" });
    expect(link).toHaveAttribute("href", "/admin/users");
  });

  it("hides the Users link from non-admins", () => {
    setRole("reviewer");
    render(<Masthead />);
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });
});

describe("Masthead user menu", () => {
  it("renders an initials avatar trigger from the email local part", () => {
    setRole("author");
    render(<Masthead />);
    const trigger = screen.getByRole("button", { name: "Account menu" });
    // ada.lovelace → AL
    expect(trigger).toHaveTextContent("AL");
  });

  it("opens to show email, role badge, and a Sign out item", async () => {
    setRole("author");
    const user = userEvent.setup();
    render(<Masthead />);
    await user.click(screen.getByRole("button", { name: "Account menu" }));

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("ada.lovelace@bowtie.com.hk")).toBeInTheDocument();
    expect(within(menu).getByText("author")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("signs out and toasts when Sign out is chosen", async () => {
    setRole("author");
    const user = userEvent.setup();
    render(<Masthead />);
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastFn).toHaveBeenCalledWith("Signed out"));
  });
});
