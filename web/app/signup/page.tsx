"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Self-service signup is retired — accounts are invite-only (provisioned by an
// admin). Show a brief notice and bounce to the sign-in page so the route still
// resolves for anyone with a stale bookmark.
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
            your admin to be added. You’ll then sign in with Google.
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

export default function SignupPage() {
  return <RetiredSignup />;
}
