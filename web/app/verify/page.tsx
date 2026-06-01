"use client";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export default function VerifyPage() {
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
    <div className="flex min-h-screen items-center justify-center px-5">
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
    </div>
  );
}
