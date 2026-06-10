import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParams,
}));

const google = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  signIn: { email: vi.fn() },
  signInWithGoogle: (redirect?: string) => google(redirect),
}));

const supabaseFlag = { value: true };
vi.mock("@/lib/supabase-client", () => ({
  isSupabaseAuth: () => supabaseFlag.value,
}));

import LoginPage from "./page";

beforeEach(() => {
  google.mockReset();
  google.mockResolvedValue({ error: null });
  supabaseFlag.value = true;
  for (const k of [...searchParams.keys()]) searchParams.delete(k);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LoginPage (supabase Google OAuth)", () => {
  it("renders the Google sign-in button, not a password or email field", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("starts Google OAuth with the post-login redirect target", async () => {
    const user = userEvent.setup();
    searchParams.set("redirect", "/runs/abc");
    render(<LoginPage />);

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(google).toHaveBeenCalledWith("/runs/abc");
  });

  it("surfaces an error when the OAuth redirect cannot be started", async () => {
    const user = userEvent.setup();
    google.mockResolvedValue({ error: { message: "boom" } });
    render(<LoginPage />);

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
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
