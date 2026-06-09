import { createClient } from "@supabase/supabase-js";

import { SUPABASE_COOKIE_NAME } from "@/lib/supabase-client";

import { loadTestEnv } from "./test-env";

/**
 * Supabase test-session minting for the Playwright harness.
 *
 * The production app signs in with a passwordless **magic link**, which can't be
 * completed headlessly (it needs an email inbox). For tests we instead use the
 * Supabase **password grant** against a provisioned test account, then inject the
 * resulting session into the browser exactly the way the app persists it.
 *
 * KEY ROBUSTNESS CHOICE: rather than hand-construct the cookie payload (whose
 * shape is an internal supabase-js detail), we run a real Supabase client with
 * an in-memory storage adapter and the SAME `storageKey` the app uses
 * (`SUPABASE_COOKIE_NAME`). After `signInWithPassword`, the client writes the
 * canonical serialized session under that key — we read it back verbatim and
 * encode it the way the app's cookie writer does (`encodeURIComponent`). The
 * app's `getSupabaseClient()` cookie storage reads it back with
 * `decodeURIComponent`, so the round-trip is byte-faithful and survives
 * supabase-js serialization changes.
 *
 * Credentials and the project URL/anon key come from the repo-root
 * `.env.test.local`; they are never printed.
 */

export class SupabaseTestConfigError extends Error {}

/** A Playwright cookie entry (subset we set). */
export interface PwCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}

/** Playwright storageState shape (cookies + per-origin localStorage). */
export interface StorageState {
  cookies: PwCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

/**
 * Mint a Supabase session via the password grant and return the encoded cookie
 * value the app expects under {@link SUPABASE_COOKIE_NAME}. Throws
 * {@link SupabaseTestConfigError} when the harness env is incomplete so callers
 * can convert it into a clean `test.skip`.
 */
export async function mintSupabaseCookieValue(): Promise<string> {
  const env = loadTestEnv();
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    throw new SupabaseTestConfigError(
      "Set E2E_SUPABASE_URL + E2E_SUPABASE_ANON_KEY in .env.test.local",
    );
  }
  if (!env.email || !env.password) {
    throw new SupabaseTestConfigError(
      "Set E2E_EMAIL + E2E_PASSWORD in .env.test.local",
    );
  }

  // In-memory storage standing in for the browser cookie store. We mirror the
  // app's client options (storageKey) so the persisted payload is identical.
  const captured: Record<string, string> = {};
  const memoryStorage = {
    getItem: (k: string): string | null => captured[k] ?? null,
    setItem: (k: string, v: string): void => {
      captured[k] = v;
    },
    removeItem: (k: string): void => {
      delete captured[k];
    },
  };

  const client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: memoryStorage,
      storageKey: SUPABASE_COOKIE_NAME,
    },
  });

  const { error } = await client.auth.signInWithPassword({
    email: env.email,
    password: env.password,
  });
  if (error) {
    // Surface the failure mode without leaking the password. A 400 here usually
    // means the test account has no password set (provision one in the Supabase
    // dashboard) or password grant is disabled for the project.
    throw new SupabaseTestConfigError(
      `Supabase password grant failed (${error.status ?? "?"}): ${error.message}`,
    );
  }

  const raw = captured[SUPABASE_COOKIE_NAME];
  if (!raw) {
    throw new SupabaseTestConfigError(
      "Supabase client did not persist a session after sign-in",
    );
  }
  return encodeURIComponent(raw);
}

/** Resolve the cookie domain from a base URL (host without port). */
function cookieDomain(baseUrl: string): { domain: string; secure: boolean } {
  const u = new URL(baseUrl);
  return { domain: u.hostname, secure: u.protocol === "https:" };
}

/**
 * Build the auth cookie(s) for `context.addCookies()` against `baseUrl`. Mirrors
 * the app cookie attributes (Path=/, SameSite=Lax, Secure on https).
 */
export async function supabaseAuthCookies(baseUrl: string): Promise<PwCookie[]> {
  const value = await mintSupabaseCookieValue();
  const { domain, secure } = cookieDomain(baseUrl);
  // ~30 days, matching the app's COOKIE_MAX_AGE_SECONDS envelope.
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  return [
    {
      name: SUPABASE_COOKIE_NAME,
      value,
      domain,
      path: "/",
      expires,
      httpOnly: false,
      secure,
      sameSite: "Lax",
    },
  ];
}

/** Build a full Playwright storageState seeded with the auth cookie. */
export async function supabaseStorageState(baseUrl: string): Promise<StorageState> {
  return { cookies: await supabaseAuthCookies(baseUrl), origins: [] };
}
