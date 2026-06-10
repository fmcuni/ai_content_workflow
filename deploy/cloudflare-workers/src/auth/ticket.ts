import type { Env } from "../index";

// Short-lived signed ticket for cross-origin SSE. The browser opens SSE
// directly against this Worker (the Next proxy buffers streams), so the
// same-origin session cookie isn't sent. The frontend fetches a ticket from the
// cookie-protected `/api/auth-ticket` route, then passes it on the SSE URL.
const TICKET_TTL_SECONDS = 60;

function base64Url(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function requireSecret(env: Env): string {
  if (!env.AUTH_SECRET) throw new Error("AUTH_SECRET is not configured");
  return env.AUTH_SECRET;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Url(sig);
}

/** Mint a short-lived signed SSE ticket bound to `userId` (format: `userId.exp.sig`). */
export async function mintTicket(env: Env, userId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const payload = `${userId}.${exp}`;
  return `${payload}.${await sign(requireSecret(env), payload)}`;
}

/** Verify an SSE ticket; returns the bound userId, or null when invalid/expired. */
export async function verifyTicket(env: Env, ticket: string): Promise<string | null> {
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const userId = parts[0];
  const expRaw = parts[1];
  const sig = parts[2];
  if (!userId || !expRaw || !sig) return null;
  const exp = Number(expRaw);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(exp) || exp < now) return null;
  const expected = await sign(requireSecret(env), `${userId}.${exp}`);
  // Constant-time comparison so a timing side-channel can't be used to forge the
  // signature byte-by-byte (plain `===` short-circuits on the first mismatch).
  if (!constantTimeEquals(expected, sig)) return null;
  return userId;
}

/**
 * Constant-time string equality. Compares two ASCII strings (base64url HMAC
 * digests) without an early exit, so the running time does not leak how many
 * leading characters matched. A length mismatch is folded into the accumulator
 * instead of short-circuiting; the loop runs over the longer of the two so the
 * iteration count never reveals the lengths either.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
