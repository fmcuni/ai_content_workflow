import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParams,
}));

const magicLink = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  signIn: { email: vi.fn() },
  signInWithMagicLink: (email: string) => magicLink(email),
}));

const supabaseFlag = { value: true };
vi.mock("@/lib/supabase-client", () => ({
  isSupabaseAuth: () => supabaseFlag.value,
}));

import LoginPage from "./page";

beforeEach(() => {
  magicLink.mockReset();
  magicLink.mockResolvedValue({ error: null });
  supabaseFlag.value = true;
  for (const k of [...searchParams.keys()]) searchParams.delete(k);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LoginPage (supabase magic-link)", () => {
  it("renders the magic-link sign-in button, not a password field", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("sends a magic link and shows enumeration-safe copy + resend cooldown", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText("Email"), "staff@bowtie.com.hk");
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));

    expect(magicLink).toHaveBeenCalledWith("staff@bowtie.com.hk");
    // Always-shown, non-committal copy regardless of whether the email exists.
    expect(screen.getByRole("status")).toHaveTextContent(/sign-in link is on its way/i);
    // Cooldown disables the resend button.
    expect(screen.getByRole("button", { name: /Resend in \d+s/ })).toBeDisabled();
  });

  it("shows the inactivity notice when reason=inactivity", () => {
    searchParams.set("reason", "inactivity");
    render(<LoginPage />);
    expect(screen.getByText(/signed out due to inactivity/i)).toBeInTheDocument();
  });

  it("falls back to the password form when not on the supabase provider", () => {
    supabaseFlag.value = false;
    render(<LoginPage />);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });
});
