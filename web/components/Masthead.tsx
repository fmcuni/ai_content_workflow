"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Runs" },
  { href: "/library", label: "Library" },
  { href: "/voices", label: "Voices" },
  { href: "/prompts", label: "Prompts" },
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
  const [now, setNow] = useState<Date | null>(null);

  // Hydration-safe: render dateline client-side only.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="bg-paper/85 backdrop-blur-md sticky top-0 z-50">
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
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
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
        <Link href="/runs/new">
          <Button variant="primary" size="sm">+ New run</Button>
        </Link>
      </div>
    </header>
  );
}
