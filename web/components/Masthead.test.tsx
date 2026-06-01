import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Role } from "@/lib/roles";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { email: "user@bowtie.com.hk" } } }),
  signOut: vi.fn(),
}));

const mockUseRole = vi.fn();
vi.mock("@/lib/use-role", () => ({
  useRole: () => mockUseRole(),
}));

import { Masthead } from "@/components/Masthead";

function setRole(role: Role) {
  const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
  mockUseRole.mockReturnValue({
    role,
    email: `${role}@bowtie.com.hk`,
    isLoading: false,
    isDevFallback: false,
    can: (required: string) => {
      // Only manage_users is consulted by the nav.
      if (required === "manage_users") return rank[role] >= rank.admin;
      return true;
    },
  });
}

beforeEach(() => {
  mockUseRole.mockReset();
});

describe("Masthead nav role gating", () => {
  it("shows the admin Users link to admins", () => {
    setRole("admin");
    render(<Masthead />);
    const link = screen.getByRole("link", { name: "Users" });
    expect(link).toHaveAttribute("href", "/admin/users");
  });

  it("hides the Users link from non-admins", () => {
    setRole("editor");
    render(<Masthead />);
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });
});
