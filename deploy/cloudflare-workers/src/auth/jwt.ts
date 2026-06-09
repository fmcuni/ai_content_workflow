/**
 * Supabase (GoTrue) JWT verification — pure, no Hono/DB coupling.
 *
 * This is the WS0 foundation for the `AUTH_PROVIDER="supabase"` branch; it is
 * NOT wired into middleware yet (that is WS1). It takes a raw `Authorization:
 * Bearer` token and returns the verified identity (`sub` + `email`) or null.
 *
 * Verification strategy (in order):
 *   1. **Asymmetric / JWKS** (preferred): when `SUPABASE_URL` is set, verify
 *      against the project's public JWKS (`/auth/v1/.well-known/jwks.json`).
 *      `jose` caches the key set and handles rotation. Algorithms restricted to
 *      RS256/ES256 (the asymmetric signing keys Supabase issues).
 *   2. **HS256 fallback**: when asymmetric verify fails (or no project URL is
 *      configured) and `SUPABASE_JWT_SECRET` is set, verify with the shared
 *      secret. This covers projects that have not enabled signing keys.
 *
 * Standard claims (`exp`, and — when a project URL is configured — `iss`/`aud`)
 * are validated by `jose`. A token missing a usable `sub` is rejected.
 *
 * Degrades safely: with neither `SUPABASE_URL` nor `SUPABASE_JWT_SECRET` set
 * (e.g. local dev), every token returns null and the caller maps that to 401.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import type { Env } from "../index";

/** Identity extracted from a verified Supabase access token. */
export interface VerifiedIdentity {
  /** The auth user uuid (JWT `sub`). */
  sub: string;
  /** The user email, when present on the token. */
  email: string | null;
}

/** GoTrue access tokens carry `aud: "authenticated"` for a logged-in user. */
const SUPABASE_AUDIENCE = "authenticated";

/** Asymmetric algorithms Supabase signs with when signing keys are enabled. */
const ASYMMETRIC_ALGS = ["RS256", "ES256"] as const;

/**
 * Module-global JWKS resolver cache, keyed by project URL. `createRemoteJWKSet`
 * itself caches fetched keys and rate-limits refetches; caching the resolver
 * keeps that state across requests on a warm isolate.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function jwksFor(supabaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(supabaseUrl);
  if (cached !== undefined) {
    return cached;
  }
  const jwksUrl = new URL("/auth/v1/.well-known/jwks.json", supabaseUrl);
  const resolver = createRemoteJWKSet(jwksUrl);
  jwksCache.set(supabaseUrl, resolver);
  return resolver;
}

function identityFromPayload(payload: JWTPayload): VerifiedIdentity | null {
  const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  if (sub === null) {
    return null;
  }
  const email =
    typeof payload.email === "string" && payload.email.length > 0 ? payload.email : null;
  return { sub, email };
}

/**
 * Verify a Supabase access token and return its identity, or null when the
 * token is invalid/expired or no verifier is configured. Never throws.
 */
export async function verifySupabaseJwt(
  token: string,
  env: Env,
): Promise<VerifiedIdentity | null> {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  const supabaseUrl = env.SUPABASE_URL?.trim();
  // When the project URL is known we can pin iss/aud; otherwise (HS256-only
  // local configs) we still enforce aud but cannot pin the issuer.
  const issuer = supabaseUrl ? `${stripTrailingSlash(supabaseUrl)}/auth/v1` : undefined;

  if (supabaseUrl) {
    // Asymmetric / JWKS is authoritative when a project URL is configured, and a
    // failure here is FINAL — we deliberately do NOT fall back to HS256. Falling
    // back would (a) let a token forged with the separate, leak-prone shared
    // secret be accepted on a project that signs asymmetrically, and (b) turn a
    // transient JWKS-fetch error (cold isolate / DNS blip) into a silent
    // algorithm downgrade. The HS256 branch below is reachable ONLY when no
    // SUPABASE_URL is set (local / dev). Production MUST enable asymmetric
    // signing keys — see the cutover checklist.
    try {
      const { payload } = await jwtVerify(token, jwksFor(supabaseUrl), {
        algorithms: [...ASYMMETRIC_ALGS],
        audience: SUPABASE_AUDIENCE,
        issuer,
      });
      return identityFromPayload(payload);
    } catch {
      return null;
    }
  }

  // HS256 fallback — ONLY when no project URL is configured (local/dev or an
  // HS256-only project with no known URL). Never reached once SUPABASE_URL is set.
  const secret = env.SUPABASE_JWT_SECRET?.trim();
  if (secret) {
    try {
      const key = new TextEncoder().encode(secret);
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["HS256"],
        audience: SUPABASE_AUDIENCE,
        issuer,
      });
      return identityFromPayload(payload);
    } catch {
      return null;
    }
  }

  return null;
}
