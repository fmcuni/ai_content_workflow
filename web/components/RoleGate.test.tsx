import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Role } from "@/lib/roles";

// Mock the role source so each test can pin a role without a network /me call.
const mockUseRole = vi.fn();
vi.mock("@/lib/use-role", () => ({
  useRole: () => mockUseRole(),
}));

import { RoleButton, RoleGate } from "@/components/RoleGate";

function setRole(role: Role | null, isLoading = false) {
  mockUseRole.mockReturnValue({
    role,
    email: role ? `${role}@bowtie.com.hk` : null,
    isLoading,
    isDevFallback: false,
    can: (required: string) => {
      const rank: Record<string, number> = {
        viewer: 0,
        author: 1,
        reviewer: 2,
        admin: 3,
      };
      const capMin: Record<string, string> = {
        read: "viewer",
        create_run: "author",
        publish: "reviewer",
        edit_prompts: "admin",
        manage_users: "admin",
      };
      if (role === null) return false;
      const need = rank[required] !== undefined ? required : capMin[required];
      if (need === undefined) return false;
      return rank[role] >= rank[need];
    },
  });
}

beforeEach(() => {
  mockUseRole.mockReset();
});

describe("RoleGate (hide)", () => {
  it("renders children when the role meets the requirement", () => {
    setRole("admin");
    render(
      <RoleGate need="manage_users">
        <span>secret</span>
      </RoleGate>,
    );
    expect(screen.getByText("secret")).toBeInTheDocument();
  });

  it("hides children when the role is insufficient", () => {
    setRole("viewer");
    render(
      <RoleGate need="manage_users">
        <span>secret</span>
      </RoleGate>,
    );
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("renders the fallback while the role is still resolving", () => {
    setRole(null, true);
    render(
      <RoleGate need="publish" fallback={<span>loading</span>}>
        <span>secret</span>
      </RoleGate>,
    );
    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });
});

describe("RoleButton (disable with hint)", () => {
  it("is enabled when the role can perform the action", () => {
    setRole("reviewer");
    render(
      <RoleButton need="publish" onClick={() => undefined}>
        Publish
      </RoleButton>,
    );
    expect(screen.getByRole("button", { name: "Publish" })).not.toBeDisabled();
  });

  it("is disabled with a hint when the role cannot perform the action", () => {
    setRole("viewer");
    render(
      <RoleButton need="publish" deniedHint="Reviewer required" onClick={() => undefined}>
        Publish
      </RoleButton>,
    );
    const btn = screen.getByRole("button", { name: "Publish" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Reviewer required");
  });

  it("preserves an existing disabled state even when the role is allowed", () => {
    setRole("admin");
    render(
      <RoleButton need="publish" disabled onClick={() => undefined}>
        Publish
      </RoleButton>,
    );
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });
});
