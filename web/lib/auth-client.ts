"use client";
import { createAuthClient } from "better-auth/react";
import { useEffect, useState } from "react";

import { getSupabaseClient, isSupabaseAuth } from "./supabase-client";

// Dual-provider auth client.
//
// Default (NEXT_PUBLIC_AUTH_PROVIDER !== "supabase") keeps the existing
// better-auth surface BYTE-FOR-BYTE: the browser talks to better-auth
// same-origin through the Next rewrite (`/api/auth/:path*` → backend, path
// preserving). baseURL is left to the current origin; basePath matches mount.
//
// When the provider is "supabase", the SAME export names resolve to
// Supabase-backed equivalents so call sites barely change:
//   - signInWithMagicLink(email) — passwordless OTP, shouldCreateUser:false
//   - signOut()                  — clears the Supabase session
//   - useSession()               — { data: { user: { email } } | null } shape
//   - authClient.getSession()    — same envelope, async (api.ts uses this)
//
// Spec: docs/superpowers/specs/2026-06-10-supabase-auth-migration.md

// Minimal session envelope shared by both providers' useSession()/getSession().
// `name` is optional: better-auth sessions carry it (used for collab display);
// Supabase sessions may not, so consumers must tolerate its absence.
export interface SessionUser {
  email: string;
  name?: string;
}
export interface SessionData {
  user: SessionUser;
}
export interface SessionResult {
  data: SessionData | null;
}

// ---- better-auth path (default) -------------------------------------------

const betterAuthClient = createAuthClient({
  basePath: "/api/auth",
});

// ---- Supabase path ---------------------------------------------------------

/**
 * Send a passwordless magic link. `shouldCreateUser: false` keeps the flow
 * invite-only; the UI always shows the same "check your inbox" copy regardless
 * of whether the address exists, so the response stays enumeration-safe.
 */
async function supabaseSignInWithMagicLink(
  email: string,
): Promise<{ error: { message: string } | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { error: { message: "Supabase auth is not configured." } };
  }
  const emailRedirectTo = `${window.location.origin}/verify`;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo },
  });
  return { error: error ? { message: error.message } : null };
}

async function supabaseSignOut(): Promise<void> {
  const supabase = getSupabaseClient();
  if (supabase) await supabase.auth.signOut();
}

async function supabaseGetSession(): Promise<SessionResult> {
  const supabase = getSupabaseClient();
  if (!supabase) return { data: null };
  const { data } = await supabase.auth.getSession();
  const email = data.session?.user?.email;
  return { data: email ? { user: { email } } : null };
}

/** Supabase-backed React hook mirroring better-auth's `useSession()` shape. */
function useSupabaseSession(): SessionResult {
  const [session, setSession] = useState<SessionResult>({ data: null });

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const email = data.session?.user?.email;
      setSession({ data: email ? { user: { email } } : null });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      const email = s?.user?.email;
      setSession({ data: email ? { user: { email } } : null });
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return session;
}

// ---- Unified exports (same names regardless of provider) -------------------

const SUPABASE = isSupabaseAuth();

/**
 * Passwordless magic-link sign-in. On the Supabase path it sends a Supabase
 * OTP; on the legacy better-auth path there is no magic-link surface, so it
 * returns a clear, non-throwing error.
 */
export async function signInWithMagicLink(
  email: string,
): Promise<{ error: { message: string } | null }> {
  if (SUPABASE) return supabaseSignInWithMagicLink(email);
  return { error: { message: "Magic-link sign-in is not enabled." } };
}

// `authClient` always exposes the better-auth surface (signIn.email,
// signUp.email, sendVerificationEmail, getSession). Legacy auth pages call
// these directly; they only render on the non-Supabase path. To resolve the
// signed-in user's email provider-agnostically, use `getSessionEmail()` below.
export const authClient = betterAuthClient;

// better-auth's destructured exports — only meaningful on the legacy path; the
// legacy auth pages import them directly.
export const signIn = betterAuthClient.signIn;
export const signUp = betterAuthClient.signUp;

/**
 * Resolve the signed-in user's email regardless of provider. Returns null when
 * there is no session. api.ts uses this to stamp X-Editor-Email.
 */
export async function getSessionEmail(): Promise<string | null> {
  if (SUPABASE) {
    const { data } = await supabaseGetSession();
    return data?.user.email ?? null;
  }
  const res = await betterAuthClient.getSession();
  return res.data?.user?.email ?? null;
}

export const signOut: () => Promise<unknown> = SUPABASE
  ? supabaseSignOut
  : betterAuthClient.signOut;

export const useSession: () => SessionResult = SUPABASE
  ? useSupabaseSession
  : (betterAuthClient.useSession as unknown as () => SessionResult);
