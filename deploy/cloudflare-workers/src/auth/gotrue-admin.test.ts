/**
 * Unit tests for the GoTrue admin REST wrapper.
 *
 * The security-critical invariants under test:
 *   - fail-closed (typed `not_configured`) when SUPABASE_URL / SERVICE_ROLE_KEY
 *     are unset — NO network call is made.
 *   - the service_role key is sent ONLY in the `apikey` + `Authorization` headers
 *     of the GoTrue request, and never appears in a thrown error message.
 *   - input validation rejects bad emails / blank ids before any fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GoTrueAdminError,
  createUser,
  deleteUser,
  generateLink,
  inviteUser,
  listUsers,
  signOutUser,
  updateUser,
  DISABLE_BAN_DURATION,
} from "./gotrue-admin";

const KEY = "super-secret-service-role-key-do-not-leak";
const env = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY };

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: FetchCall[] = [];

function mockFetch(status: number, jsonBody: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: (init.method ?? "GET").toUpperCase(),
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
      });
      return new Response(jsonBody === null ? "" : JSON.stringify(jsonBody), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fail-closed when unconfigured", () => {
  it("throws a typed not_configured error and makes NO fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(inviteUser({}, "a@b.com")).rejects.toMatchObject({
      code: "not_configured",
      status: 501,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a blank service_role key", async () => {
    await expect(
      inviteUser({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "  " }, "a@b.com"),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("rejects a malformed SUPABASE_URL", async () => {
    await expect(
      inviteUser({ SUPABASE_URL: "not a url", SUPABASE_SERVICE_ROLE_KEY: KEY }, "a@b.com"),
    ).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("service_role key handling", () => {
  it("sends the key in apikey + Authorization headers and nowhere else", async () => {
    mockFetch(200, { id: "u1", email: "a@b.com" });
    await inviteUser(env, "a@b.com");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://proj.supabase.co/auth/v1/invite");
    expect(call.headers.apikey).toBe(KEY);
    expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
    // The body must NOT carry the key.
    expect(call.body ?? "").not.toContain(KEY);
  });

  it("never leaks the key in a thrown error message", async () => {
    mockFetch(403, { msg: "not allowed" });
    let thrown: unknown;
    try {
      await inviteUser(env, "a@b.com");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GoTrueAdminError);
    const err = thrown as GoTrueAdminError;
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(err.code).toBe("gotrue_error");
  });
});

describe("input validation (before any fetch)", () => {
  it("rejects an invalid email", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(inviteUser(env, "not-an-email")).rejects.toMatchObject({ code: "invalid_input" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a blank user id on delete", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(deleteUser(env, "  ")).rejects.toMatchObject({ code: "invalid_input" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an unsupported link type", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    // @ts-expect-error — deliberately wrong type to test runtime guard.
    await expect(generateLink(env, "phone_change", "a@b.com")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("endpoint shapes", () => {
  it("createUser POSTs /admin/users with email_confirm true", async () => {
    mockFetch(200, { id: "u1", email: "a@b.com" });
    await createUser(env, "a@b.com");
    expect(calls[0]!.url).toBe("https://proj.supabase.co/auth/v1/admin/users");
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ email: "a@b.com", email_confirm: true });
  });

  it("updateUser PUTs /admin/users/:id with ban_duration (url-encoded id)", async () => {
    mockFetch(200, { id: "u 1", email: "a@b.com" });
    await updateUser(env, "u 1", { ban_duration: DISABLE_BAN_DURATION });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://proj.supabase.co/auth/v1/admin/users/u%201");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ ban_duration: DISABLE_BAN_DURATION });
  });

  it("signOutUser POSTs /admin/users/:id/logout", async () => {
    mockFetch(200, null);
    await signOutUser(env, "u1");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://proj.supabase.co/auth/v1/admin/users/u1/logout");
  });

  it("generateLink POSTs /admin/generate_link with type + email", async () => {
    mockFetch(200, { action_link: "https://x", verification_type: "invite" });
    const r = await generateLink(env, "invite", "a@b.com");
    expect(calls[0]!.url).toBe("https://proj.supabase.co/auth/v1/admin/generate_link");
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ type: "invite", email: "a@b.com" });
    expect(r.action_link).toBe("https://x");
  });

  it("listUsers unwraps the { users: [...] } page", async () => {
    mockFetch(200, { users: [{ id: "u1", email: "a@b.com" }] });
    const users = await listUsers(env);
    expect(calls[0]!.url).toContain("/auth/v1/admin/users?page=1&per_page=1000");
    expect(users).toHaveLength(1);
  });

  it("surfaces a GoTrue 404 as a 404-coded error", async () => {
    mockFetch(404, { msg: "user not found" });
    await expect(deleteUser(env, "missing")).rejects.toMatchObject({
      code: "gotrue_error",
      status: 404,
    });
  });
});
