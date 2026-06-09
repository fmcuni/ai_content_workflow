/**
 * Unit tests for verifySupabaseJwt. The HS256 path is deterministic (sign with a
 * known secret); the asymmetric/JWKS network path is covered by integration in
 * WS1/WS5. The one test that sets SUPABASE_URL points at an unreachable host so
 * the JWKS attempt fails fast and the HS256 fallback (with issuer pinning) runs.
 */
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import type { Env } from "../index";
import { verifySupabaseJwt } from "./jwt";

const SECRET = "test-shared-secret-please-ignore";
const KEY = new TextEncoder().encode(SECRET);

function envWith(over: Partial<Env> = {}): Env {
  return { SUPABASE_JWT_SECRET: SECRET, ...over } as Env;
}

interface TokenOpts {
  sub?: string | null;
  email?: string;
  audience?: string;
  issuer?: string;
  expiresInSec?: number;
  secret?: Uint8Array;
}

async function makeToken(opts: TokenOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expiresInSec ?? 3600);
  let builder = new SignJWT({ email: opts.email ?? "user@bowtie.com.hk" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setAudience(opts.audience ?? "authenticated");
  if (opts.sub !== null) {
    builder = builder.setSubject(opts.sub ?? "uuid-123");
  }
  if (opts.issuer !== undefined) {
    builder = builder.setIssuer(opts.issuer);
  }
  return builder.sign(opts.secret ?? KEY);
}

describe("verifySupabaseJwt — HS256 fallback", () => {
  it("verifies a well-formed token and returns sub + email", async () => {
    const token = await makeToken({ sub: "abc", email: "a@bowtie.com.hk" });
    const id = await verifySupabaseJwt(token, envWith());
    expect(id).toEqual({ sub: "abc", email: "a@bowtie.com.hk" });
  });

  it("returns email null when the claim is absent", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .setSubject("no-email")
      .setAudience("authenticated")
      .sign(KEY);
    expect(await verifySupabaseJwt(token, envWith())).toEqual({ sub: "no-email", email: null });
  });

  it("rejects an expired token", async () => {
    const token = await makeToken({ expiresInSec: -60 });
    expect(await verifySupabaseJwt(token, envWith())).toBeNull();
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = await makeToken({ secret: new TextEncoder().encode("other-secret") });
    expect(await verifySupabaseJwt(token, envWith())).toBeNull();
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await makeToken({ audience: "anon" });
    expect(await verifySupabaseJwt(token, envWith())).toBeNull();
  });

  it("rejects a token with no sub", async () => {
    const token = await makeToken({ sub: null });
    expect(await verifySupabaseJwt(token, envWith())).toBeNull();
  });

  it("rejects an empty token without throwing", async () => {
    expect(await verifySupabaseJwt("", envWith())).toBeNull();
  });
});

describe("verifySupabaseJwt — no verifier configured", () => {
  it("returns null when neither SUPABASE_URL nor SUPABASE_JWT_SECRET is set", async () => {
    const token = await makeToken();
    expect(await verifySupabaseJwt(token, {} as Env)).toBeNull();
  });
});

describe("verifySupabaseJwt — JWKS unreachable → HS256 fallback + issuer pin", () => {
  // SUPABASE_URL set to an unreachable host: the JWKS verify throws (fetch
  // fails), then the HS256 fallback runs with the derived issuer enforced.
  const env = envWith({ SUPABASE_URL: "https://unreachable.invalid" });
  const issuer = "https://unreachable.invalid/auth/v1";

  it("verifies via HS256 when the token's issuer matches the project", async () => {
    const token = await makeToken({ sub: "iss-ok", issuer });
    expect(await verifySupabaseJwt(token, env)).toEqual({
      sub: "iss-ok",
      email: "user@bowtie.com.hk",
    });
  });

  it("rejects a token whose issuer does not match the project", async () => {
    const token = await makeToken({ issuer: "https://evil.example/auth/v1" });
    expect(await verifySupabaseJwt(token, env)).toBeNull();
  });
});
