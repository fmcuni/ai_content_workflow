"use client";
import { useEffect, useState } from "react";

import { getSupabaseClient } from "./supabase-client";

// Supabase-backed auth client (GoTrue). The legacy better-auth provider was
// retired, so these are the unconditional implementations.
//
//   - signInWithGoogle(redirect) — Google OAuth, invite-only (gate is backend)
//   - signOut()                  — clears the Supabase session
//   - useSession()               — { data: { user: { email } } | null } shape
//   - getSessionEmail()          — resolves the signed-in user's email (api.ts)
//
// Spec: docs/design/specs/2026-06-10-supabase-auth-migration.md

// Minimal session envelope returned by useSession()/getSessionEmail().
// `name` is optional: Supabase sessions may not carry it, so consumers must
// tolerate its absence.
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

/**
 * Begin Google OAuth via Supabase. Redirects the browser to Google; the return
 * leg lands on `/verify`, which exchanges the PKCE `?code=` for a session (see
 * web/app/verify/page.tsx). `redirect` is the post-login target, preserved
 * through Supabase's callback via the `?redirect=` query param `/verify` reads.
 *
 * Note: invite-only is NOT enforced here — Supabase auto-creates a GoTrue user
 * for any Google account. The gate is the backend authz layer, which denies a
 * session with no `content_tool.app_user` row (see authz.ts `effectiveRole`).
 */
export async function signInWithGoogle(
  redirect?: string,
): Promise<{ error: { message: string } | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { error: { message: "Supabase auth is not configured." } };
  }
  const query = redirect ? `?redirect=${encodeURIComponent(redirect)}` : "";
  const redirectTo = `${window.location.origin}/verify${query}`;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, queryParams: { prompt: "select_account" } },
  });
  return { error: error ? { message: error.message } : null };
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseClient();
  if (supabase) await supabase.auth.signOut();
}

/**
 * Resolve the signed-in user's email, or null when there is no session.
 * api.ts uses this to stamp X-Editor-Email.
 */
export async function getSessionEmail(): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.email ?? null;
}

/** Supabase-backed React hook exposing the shared SessionResult envelope. */
export function useSession(): SessionResult {
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
