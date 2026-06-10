"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn, signInWithGoogle } from "@/lib/auth-client";
import { isSupabaseAuth } from "@/lib/supabase-client";

// ---- Supabase Google OAuth ------------------------------------------------

function GoogleSignInForm() {
  const params = useSearchParams();
  const reason = params.get("reason");
  const redirectTo = params.get("redirect") || "/";

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

// ---- legacy better-auth form (unchanged) ----------------------------------

function PasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirect") || "/";
  const justVerified = params.get("verified") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { error } = await signIn.email({ email, password });
      if (error) {
        setError(
          error.status === 403
            ? "Please verify your email before signing in. Check your inbox."
            : error.message || "Sign-in failed.",
        );
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Bowtie Content Desk · staff access</CardDescription>
      </CardHeader>
      <CardContent>
        {justVerified ? (
          <p className="mb-4 text-sm text-accent">Email verified — you can sign in now.</p>
        ) : null}
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" variant="primary" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="mt-4 text-sm text-ink-soft">
          No account?{" "}
          <Link href="/signup" className="text-accent hover:underline">
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

function LoginForm() {
  return isSupabaseAuth() ? <GoogleSignInForm /> : <PasswordForm />;
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
