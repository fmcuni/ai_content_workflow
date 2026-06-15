"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeRedirect } from "@/lib/safe-redirect";
import { getSupabaseClient } from "@/lib/supabase-client";

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

      const redirectTo = safeRedirect(params.get("redirect"));
      const code = params.get("code");
      const tokenHash = params.get("token_hash");
      const type = params.get("type");

      try {
        if (code) {
          // PKCE flow: exchange the auth code for a session.
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (tokenHash) {
          // Email OTP / magic-link token-hash flow. Validate the attacker-
          // influenced `type` param against an allowlist rather than casting it.
          const VALID_OTP_TYPES: readonly EmailOtpType[] = [
            "magiclink",
            "signup",
            "email",
            "recovery",
            "invite",
            "email_change",
          ];
          const resolvedType: EmailOtpType = (VALID_OTP_TYPES as readonly string[]).includes(
            type ?? "",
          )
            ? (type as EmailOtpType)
            : "email";
          const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: resolvedType,
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

export default function VerifyPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <Suspense fallback={null}>
        <SupabaseVerify />
      </Suspense>
    </div>
  );
}
