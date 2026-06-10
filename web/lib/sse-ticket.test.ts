import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the auth provider gate + browser Supabase client. Each test sets the
// behaviour it needs via these handles.
const isSupabaseAuthMock = vi.fn<() => boolean>();
const getSessionMock = vi.fn();
const refreshSessionMock = vi.fn();

vi.mock("./supabase-client", () => ({
  isSupabaseAuth: () => isSupabaseAuthMock(),
  getSupabaseClient: () => ({
    auth: { getSession: getSessionMock, refreshSession: refreshSessionMock },
  }),
}));

import { withSseTicket } from "./sse-ticket";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("withSseTicket", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    isSupabaseAuthMock.mockReset();
    getSessionMock.mockReset();
    refreshSessionMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends the ticket and does NOT attach a Bearer header on better-auth", async () => {
    isSupabaseAuthMock.mockReturnValue(false);
    fetchMock.mockResolvedValue(jsonResponse({ ticket: "abc" }));

    const url = await withSseTicket("wss://api.example/runs/r1/doc");

    expect(url).toBe("wss://api.example/runs/r1/doc?ticket=abc");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("attaches the Supabase access token as a Bearer header on supabase auth", async () => {
    isSupabaseAuthMock.mockReturnValue(true);
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt-1" } } });
    fetchMock.mockResolvedValue(jsonResponse({ ticket: "tk" }));

    const url = await withSseTicket("wss://api.example/runs/r1/events");

    expect(url).toBe("wss://api.example/runs/r1/events?ticket=tk");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
  });

  it("force-refreshes the token once and retries when the ticket fetch 401s", async () => {
    isSupabaseAuthMock.mockReturnValue(true);
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "stale" } } });
    refreshSessionMock.mockResolvedValue({ data: { session: { access_token: "fresh" } } });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ticket: "tk2" }));

    const url = await withSseTicket("wss://api.example/runs/r1/doc");

    expect(url).toBe("wss://api.example/runs/r1/doc?ticket=tk2");
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).authorization).toBe("Bearer fresh");
  });

  it("returns the URL unchanged when the ticket fetch ultimately fails", async () => {
    isSupabaseAuthMock.mockReturnValue(true);
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "stale" } } });
    refreshSessionMock.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    const url = await withSseTicket("wss://api.example/runs/r1/doc");

    expect(url).toBe("wss://api.example/runs/r1/doc");
  });

  it("uses & as the separator when the URL already has a query string", async () => {
    isSupabaseAuthMock.mockReturnValue(false);
    fetchMock.mockResolvedValue(jsonResponse({ ticket: "abc" }));

    const url = await withSseTicket("wss://api.example/runs/r1/events?foo=1");

    expect(url).toBe("wss://api.example/runs/r1/events?foo=1&ticket=abc");
  });
});
