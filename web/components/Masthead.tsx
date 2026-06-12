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

// Nav entries match their own path or any sub-path (so /runs/{id}/hitl2 keeps the
// Runs tab lit). `aliases` adds extra exact-match paths — the Runs ledger also
// owns the legacy home "/".
interface NavItem {
  href: string;
  label: string;
  aliases?: string[];
}

function navActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.href || pathname.startsWith(item.href + "/")) return true;
  return (item.aliases ?? []).includes(pathname);
}

const NAV: NavItem[] = [
  { href: "/runs", label: "Runs", aliases: ["/"] },
  { href: "/topic-batches", label: "Topics" },
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

// Editorial dateline: `VOL. NN · YYYY-MM-DD` (matches the redesign demo's
// masthead-date; ISO date also satisfies the house YYYY-MM-DD convention).
function dateStamp(d: Date): string {
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `VOL. ${String(isoWeek(d)).padStart(2, "0")}  ·  ${iso}`;
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

  // Sync handler (DropdownMenuItem onClick doesn't await) wrapping a contained
  // async flow so a signOut() rejection can't become an unhandled rejection. We
  // still clear the client UI and navigate regardless of the network outcome.
  function onSignOut(): void {
    void (async () => {
      try {
        await signOut();
      } catch {
        // best-effort sign-out — fall through to clear the session UI
      }
      toast("Signed out");
      router.push("/login");
      router.refresh();
    })();
  }

  return (
    <header className="bg-paper/85 backdrop-blur-md">
      <div className="mx-auto max-w-[1400px] px-5 md:px-7 pt-2.5 pb-2 flex items-center justify-between">
        <Link
          href="/runs"
          className="font-display text-[13px] tracking-[0.18em] uppercase font-semibold text-ink hover:text-accent transition-colors"
          style={{ fontVariationSettings: '"opsz" 14, "SOFT" 60' }}
        >
          Bowtie AI Content Workflow
        </Link>
        <div className="font-mono text-[11px] tracking-[0.08em] text-ink-faint uppercase">
          {now ? dateStamp(now) : ""}
        </div>
      </div>
      <div className="mx-auto max-w-[1400px] px-5 md:px-7 flex items-center justify-between border-t border-rule/60">
        <nav className="flex items-baseline gap-[22px] text-[12.5px]">
          {navItems.map((n) => {
            const active = navActive(n, pathname);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block py-2.5 transition-colors",
                  active
                    ? "text-ink font-semibold shadow-[inset_0_-2px_0_var(--color-accent)]"
                    : "text-ink-soft hover:text-ink"
                )}
              >
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
