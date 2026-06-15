import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const replace = vi.fn();
const refresh = vi.fn();
const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  useSearchParams: () => searchParams,
}));

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();
vi.mock("@/lib/supabase-client", () => ({
  getSupabaseClient: () => ({
    auth: { exchangeCodeForSession, verifyOtp },
  }),
}));

import VerifyPage from "./page";

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  for (const k of [...searchParams.keys()]) searchParams.delete(k);
});

describe("VerifyPage (supabase PKCE callback)", () => {
  it("exchanges a PKCE code and redirects to ?redirect", async () => {
    searchParams.set("code", "abc123");
    searchParams.set("redirect", "/runs");
    render(<VerifyPage />);

    await waitFor(() => expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/runs"));
  });

  it("verifies a token_hash OTP link and redirects home by default", async () => {
    searchParams.set("token_hash", "hash-xyz");
    searchParams.set("type", "magiclink");
    render(<VerifyPage />);

    await waitFor(() =>
      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "hash-xyz", type: "magiclink" }),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("shows an error (no redirect) when the exchange fails", async () => {
    searchParams.set("code", "bad");
    exchangeCodeForSession.mockResolvedValue({ error: { message: "expired" } });
    render(<VerifyPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid or has expired/i);
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows an error when the link has no code or token_hash", async () => {
    render(<VerifyPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid or has expired/i);
  });
});
