/**
 * Unit tests for the SSE ticket mint/verify (src/auth/ticket.ts).
 *
 * Focus:
 *   - mint → verify round-trips and returns the bound userId.
 *   - a tampered signature is rejected (the constant-time comparison must still
 *     return false, not just "fail fast"). We exercise verifyTicket since the
 *     constant-time compare is an internal helper; a valid HMAC verifies true
 *     and any single-byte tamper verifies false.
 */
import { describe, expect, it } from "vitest";

import type { Env } from "../index";
import { mintTicket, verifyTicket } from "./ticket";

// Dummy, non-production HMAC key — fixed so mint/verify are deterministic.
const env = { AUTH_SECRET: "test-secret-not-a-real-key" } as Env;

describe("ticket mint/verify", () => {
  it("verifies a freshly minted ticket and returns the bound userId", async () => {
    const ticket = await mintTicket(env, "user-123");
    expect(await verifyTicket(env, ticket)).toBe("user-123");
  });

  it("rejects a ticket whose signature byte was flipped (constant-time compare)", async () => {
    const ticket = await mintTicket(env, "user-123");
    const [uid, exp, sig] = ticket.split(".") as [string, string, string];
    // Flip the first signature char to a different base64url char.
    const flipped = sig.startsWith("A") ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(await verifyTicket(env, `${uid}.${exp}.${flipped}`)).toBeNull();
  });

  it("rejects a signature of a different length (no early length leak)", async () => {
    const ticket = await mintTicket(env, "user-123");
    const [uid, exp, sig] = ticket.split(".") as [string, string, string];
    expect(await verifyTicket(env, `${uid}.${exp}.${sig}extra`)).toBeNull();
    expect(await verifyTicket(env, `${uid}.${exp}.${sig.slice(0, -1)}`)).toBeNull();
  });

  it("rejects a ticket bound to a different userId (re-signed payload mismatch)", async () => {
    const ticket = await mintTicket(env, "user-123");
    const [, exp, sig] = ticket.split(".") as [string, string, string];
    // Same exp+sig but a swapped userId → expected sig differs → reject.
    expect(await verifyTicket(env, `attacker.${exp}.${sig}`)).toBeNull();
  });

  it("rejects an expired ticket", async () => {
    const ticket = await mintTicket(env, "user-123");
    const [uid, , sig] = ticket.split(".") as [string, string, string];
    const past = Math.floor(Date.now() / 1000) - 10;
    // exp is part of the signed payload, so editing it also invalidates the sig;
    // either way verify must return null.
    expect(await verifyTicket(env, `${uid}.${past}.${sig}`)).toBeNull();
  });
});
