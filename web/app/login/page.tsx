"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSessionEmail, signInWithGoogle, signOut } from "@/lib/auth-client";
import { safeRedirect } from "@/lib/safe-redirect";

// ---- Supabase Google OAuth ------------------------------------------------

function GoogleSignInForm() {
  const params = useSearchParams();
  const reason = params.get("reason");
  const redirectTo = safeRedirect(params.get("redirect"));

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A Supabase session cookie can still be present on /login when the backend
  // rejected it: an authenticated-but-unprovisioned account (invite-only denies
  // it at the authz layer), or an expired/invalid token that failed to refresh
  // — in both cases api.ts routes here. Re-offering "Continue with Google" then
  // just loops (the stale session survives the OAuth round-trip), so detect the
  // lingering session and offer a sign-out escape instead.
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    void getSessionEmail().then((email) => {
      if (!active) return;
      setSessionEmail(email);
      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function onContinue() {
    if (pending) return;
    setError(null);
    setPending(true);
    // On success the browser is redirected to Google and we never return here;
    // only a failed redirect-start resolves with an error (so clear `pending`).
    const { error } = await signInWithGoogle(redirectTo);
    if (error) {
      setError(error.message || "Could not start Google sign-in.");
      setPending(false);
    }
  }

  async function onSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      // Drop back to the clean "Continue with Google" state regardless of the
      // sign-out result — the cookie is cleared either way.
      setSessionEmail(null);
      setSigningOut(false);
    }
  }

  // Signed in but still on /login ⇒ the session was rejected by the backend
  // (unprovisioned/denied account, or a stale token). Show a sign-out escape
  // rather than a Google loop.
  if (!checking && sessionEmail) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Account not authorized</CardTitle>
          <CardDescription>Bowtie Content Desk · staff access</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-soft">
            You’re signed in as{" "}
            <span className="font-medium text-ink">{sessionEmail}</span>, but this account doesn’t
            have access. Access is invite-only — ask your admin to provision your account, then
            sign in again. If your session simply expired, sign out and sign in again.
          </p>
          <Button
            type="button"
            variant="primary"
            className="mt-4 w-full"
            disabled={signingOut}
            onClick={onSignOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
          <p className="mt-4 text-sm text-ink-soft">
            Need access?{" "}
            <Link href="/signup" className="text-accent hover:underline">
              Contact your admin
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Bowtie Content Desk · staff access</CardDescription>
      </CardHeader>
      <CardContent>
        {reason === "inactivity" ? (
          <p className="mb-4 text-sm text-ink-soft">
            You were signed out due to inactivity. Sign in again to continue.
          </p>
        ) : null}
        <Button
          type="button"
          variant="primary"
          className="w-full"
          disabled={pending}
          onClick={onContinue}
        >
          {pending ? "Redirecting…" : "Continue with Google"}
        </Button>
        {error ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <p className="mt-4 text-sm text-ink-soft">
          Access is invite-only. Need an account?{" "}
          <Link href="/signup" className="text-accent hover:underline">
            Contact your admin
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <Suspense fallback={null}>
        <GoogleSignInForm />
      </Suspense>
    </div>
  );
}
