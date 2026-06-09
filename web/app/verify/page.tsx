"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { getSupabaseClient, isSupabaseAuth } from "@/lib/supabase-client";

type EmailOtpType = "magiclink" | "signup" | "email" | "recovery" | "invite" | "email_change";

// ---- Supabase PKCE / OTP callback -----------------------------------------

function SupabaseVerify() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function exchange() {
      const supabase = getSupabaseClient();
      if (!supabase) {
        setError("Supabase auth is not configured.");
        return;
      }

      const redirectTo = params.get("redirect") || "/";
      const code = params.get("code");
      const tokenHash = params.get("token_hash");
      const type = params.get("type");

      try {
        if (code) {
          // PKCE flow: exchange the auth code for a session.
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (tokenHash) {
          // Email OTP / magic-link token-hash flow.
          const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: (type as EmailOtpType) || "email",
          });
          if (error) throw error;
        } else {
          throw new Error("missing-code");
        }
        if (!active) return;
        router.replace(redirectTo);
        router.refresh();
      } catch {
        if (!active) return;
        setError("This sign-in link is invalid or has expired. Request a new one.");
      }
    }

    void exchange();
    return () => {
      active = false;
    };
  }, [params, router]);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{error ? "Sign-in failed" : "Signing you in…"}</CardTitle>
        <CardDescription>
          {error ? "We couldn’t verify this link." : "Completing your sign-in."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <>
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
            <p className="mt-4 text-sm text-ink-soft">
              <Link href="/login" className="text-accent hover:underline">
                Back to sign in
              </Link>
            </p>
          </>
        ) : (
          <p className="text-sm text-ink-soft" role="status">
            One moment…
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---- legacy better-auth resend-verification form (unchanged) --------------

function ResendVerification() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onResend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setPending(true);
    try {
      const { error } = await authClient.sendVerificationEmail({
        email,
        callbackURL: "/login?verified=1",
      });
      if (error) {
        setError(error.message || "Could not send verification email.");
        return;
      }
      setMessage(`Verification email sent to ${email}.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Verify your email</CardTitle>
        <CardDescription>Didn’t get the link? Resend it below.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onResend} className="space-y-4">
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
          {message ? <p className="text-sm text-accent">{message}</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" variant="primary" className="w-full" disabled={pending}>
            {pending ? "Sending…" : "Resend verification"}
          </Button>
        </form>
        <p className="mt-4 text-sm text-ink-soft">
          <Link href="/login" className="text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

function VerifyInner() {
  return isSupabaseAuth() ? <SupabaseVerify /> : <ResendVerification />;
}

export default function VerifyPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <Suspense fallback={null}>
        <VerifyInner />
      </Suspense>
    </div>
  );
}
