"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { toast } from "sonner";

import { isAuthRoute } from "@/lib/auth-routes";
import { signOut } from "@/lib/auth-client";
import { idleWatchdogEnabled, useIdleWatchdog } from "@/lib/auth/idle-watchdog";

// Mounts the inactivity watchdog inside the authenticated shell. On expiry it
// signs the user out, shows an "inactivity" toast, and routes to
// /login?reason=inactivity. No-op on the legacy auth path and on auth pages
// (login/verify/signup), where there is no session to expire.
export function IdleWatchdog(): null {
  const pathname = usePathname();
  const router = useRouter();

  const onExpire = useCallback(() => {
    void (async () => {
      try {
        await signOut();
      } finally {
        toast("Signed out due to inactivity");
        router.push("/login?reason=inactivity");
        router.refresh();
      }
    })();
  }, [router]);

  const enabled = idleWatchdogEnabled() && !isAuthRoute(pathname);
  useIdleWatchdog({ onExpire, enabled });

  return null;
}
