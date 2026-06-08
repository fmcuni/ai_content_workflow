"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { isAuthRoute } from "@/lib/auth-routes";
import { signOut, useSession } from "@/lib/auth-client";
import { useRole } from "@/lib/use-role";
import { cn } from "@/lib/utils";

// `exact` entries match only their own path (so the Desk's "/" and the Ledger's
// "/runs" don't both light up, and deeper run pages like /runs/{id}/hitl2 don't
// activate the Ledger tab); the rest match on prefix.
interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
}

const NAV: NavItem[] = [
  { href: "/", label: "Runs", exact: true },
  { href: "/runs", label: "Ledger", exact: true },
  { href: "/voices", label: "Voices" },
  { href: "/prompts", label: "Prompts" },
];

// Admin-only nav entries, appended when the operator can manage users.
const ADMIN_NAV: NavItem[] = [{ href: "/admin/users", label: "Users" }];

function isoWeek(d: Date): number {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}

function dateline(d: Date): string {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${days[d.getDay()]} ${String(d.getDate()).padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

export function Masthead() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { can } = useRole();
  const navItems = can("manage_users") ? [...NAV, ...ADMIN_NAV] : NAV;
  const [now, setNow] = useState<Date | null>(null);

  // Hydration-safe: render dateline client-side only.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // No masthead chrome on the auth pages.
  if (isAuthRoute(pathname)) return null;

  async function onSignOut() {
    await signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="bg-paper/85 backdrop-blur-md">
      <div className="mx-auto max-w-[1180px] px-5 md:px-10 pt-6 pb-3 flex items-center justify-between">
        <Link
          href="/"
          className="font-display text-[15px] tracking-[0.16em] uppercase font-medium text-ink hover:text-accent transition-colors"
          style={{ fontVariationSettings: '"opsz" 14, "SOFT" 60' }}
        >
          Bowtie AI Content Workflow
        </Link>
        <div className="font-mono text-[11px] tracking-wider text-ink-faint uppercase">
          {now ? `VOL. ${isoWeek(now)}  ·  ${dateline(now)}` : ""}
        </div>
      </div>
      <div className="mx-auto max-w-[1180px] px-5 md:px-10 pb-3 flex items-center justify-between">
        <nav className="flex items-center gap-6 text-[13px]">
          {navItems.map((n) => {
            const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "transition-colors hover:text-ink inline-flex items-center gap-1.5",
                  active ? "text-ink" : "text-ink-soft"
                )}
              >
                <span
                  aria-hidden
                  className={cn("text-accent text-[10px]", active ? "opacity-100" : "opacity-0")}
                >
                  ▪
                </span>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-4">
          {session?.user ? (
            <div className="hidden md:flex items-center gap-3 font-mono text-[11px] text-ink-faint">
              <span className="truncate max-w-[180px]" title={session.user.email}>
                {session.user.email}
              </span>
              <button
                type="button"
                onClick={onSignOut}
                className="uppercase tracking-wider hover:text-ink transition-colors"
              >
                Sign out
              </button>
            </div>
          ) : null}
          <Link href="/runs/new">
            <Button variant="primary" size="sm">+ New run</Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
