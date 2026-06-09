"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signUp } from "@/lib/auth-client";
import { isSupabaseAuth } from "@/lib/supabase-client";

const ALLOWED_DOMAIN = "bowtie.com.hk";

// Under Supabase auth, self-service signup is retired — accounts are
// invite-only (provisioned by an admin). Show a brief notice and bounce to the
// sign-in page so the route still resolves for anyone with a stale bookmark.
function RetiredSignup() {
  const router = useRouter();

  useEffect(() => {
    const id = setTimeout(() => router.replace("/login"), 4000);
    return () => clearTimeout(id);
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Account creation is managed</CardTitle>
          <CardDescription>Bowtie Content Desk · staff access</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-soft">
            Self-service signup is no longer available. To get access, contact
            your admin to be added. You’ll then sign in with a magic link.
          </p>
          <p className="mt-4 text-sm text-ink-soft">
            <Link href="/login" className="text-accent hover:underline">
              Go to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function LegacySignup() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { error } = await signUp.email({
        name,
        email,
        password,
        callbackURL: "/login?verified=1",
      });
      if (error) {
        setError(error.message || "Sign-up failed.");
        return;
      }
      setDone(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create account</CardTitle>
          <CardDescription>
            Restricted to <span className="font-mono">@{ALLOWED_DOMAIN}</span> email addresses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <p className="text-sm text-ink-soft">
              Check <span className="text-ink">{email}</span> for a verification link. You can sign
              in once your email is verified.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
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
                  autoComplete="new-password"
                  minLength={10}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-xs text-ink-faint">At least 10 characters.</p>
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" variant="primary" className="w-full" disabled={pending}>
                {pending ? "Creating…" : "Create account"}
              </Button>
            </form>
          )}
          <p className="mt-4 text-sm text-ink-soft">
            Already have an account?{" "}
            <Link href="/login" className="text-accent hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SignupPage() {
  return isSupabaseAuth() ? <RetiredSignup /> : <LegacySignup />;
}
