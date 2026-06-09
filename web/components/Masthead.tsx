"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isAuthRoute } from "@/lib/auth-routes";
import { signOut, useSession } from "@/lib/auth-client";
import { useRole } from "@/lib/use-role";
import { cn } from "@/lib/utils";

// First two initials from an email's local part (before @). "ada.lovelace@x"
// → "AL"; single-token "ada@x" → "AD". Used for the avatar chip.
function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const parts = local.split(/[.\-_+]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

interface UserMenuProps {
  email: string;
  role: string | null;
  onSignOut: () => void;
}

// Initials-avatar button + dropdown (email, role badge, Sign out). Visible on
// all breakpoints (mobile included) — the avatar is the trigger.
function UserMenu({ email, role, onSignOut }: UserMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-[11px] font-mono font-medium uppercase tracking-wide text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {initialsFromEmail(email)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-1.5">
              <span className="truncate text-[12px] text-ink" title={email}>
                {email}
              </span>
              {role ? (
                <Badge variant="secondary" className="w-fit uppercase tracking-wide">
                  {role}
                </Badge>
              ) : null}
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
const ADMIN_NAV: NavItem[] = [
  { href: "/settings/publish-targets", label: "Targets" },
  { href: "/admin/users", label: "Users" },
];

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
  const { can, role } = useRole();
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
    toast("Signed out");
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
          <Link href="/runs/new">
            <Button variant="primary" size="sm">+ New run</Button>
          </Link>
          {session?.user ? (
            <UserMenu email={session.user.email} role={role} onSignOut={onSignOut} />
          ) : null}
        </div>
      </div>
    </header>
  );
}
