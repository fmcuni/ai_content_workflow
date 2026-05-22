# Web UI Editorial Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current generic shadcn-defaults look across `web/app/**` with a single, cohesive **Modern Newsroom CMS** identity — masthead/folio header, Fraunces + IBM Plex Sans/Mono, cream paper + ink + editorial red — and apply it deeply to all five page templates plus the shared component primitives.

**Architecture:** Token-first restyle on top of the existing shadcn + Tailwind v4 + base-ui foundation. Replace tokens in `globals.css`, load five Google font families via `next/font/google`, remap existing shadcn semantic tokens (`--background`, `--foreground`, `--primary`, etc.) so unmodified shadcn components inherit. Three new presentation primitives (`Masthead`, `Folio`, `SectionHead`, `PaperStamp`) carry the editorial chrome. Restyle each `web/components/ui/*` and project component to drop shadcn defaults (rounded blobs, card backgrounds, generic badges) in favor of the paper-and-ink language. Each page then composes the new primitives with no behavior changes.

**Tech Stack:** Next.js 16, React 19, Tailwind v4, shadcn/ui (over `@base-ui/react` primitives), TanStack Query, Tiptap, sonner, Playwright tests.

**Note on TDD:** This is a presentation-only redesign. We preserve behavior parity with existing Playwright tests rather than writing new failing tests. Each task verifies via type-check + dev-server render check. The final task updates Playwright tests if selectors changed and runs the suite.

**Spec:** [`docs/superpowers/specs/2026-05-22-web-ui-editorial-redesign-design.md`](../specs/2026-05-22-web-ui-editorial-redesign-design.md)

---

## File Structure

**New files:**
```
web/components/Masthead.tsx           # Global header with folio/dateline/nav
web/components/Folio.tsx              # 2px+1px ink rule pair primitive
web/components/SectionHead.tsx        # kicker/hed/dek section header primitive
web/components/PaperStamp.tsx         # outlined small-caps stamp primitive
web/lib/build-info.ts                 # exposes BUILD_SHA / BUILD_DATE
```

**Modified files (presentation-only):**
```
web/app/globals.css                   # token replacement, fonts, base
web/app/layout.tsx                    # mount Masthead + Footer, attach font CSS vars
web/app/page.tsx                      # ledger-style runs list
web/app/library/page.tsx              # archive page header + toolbar
web/app/runs/new/page.tsx             # assignment-sheet form
web/app/runs/[runId]/page.tsx         # story-page run detail
web/app/runs/[runId]/hitl1/page.tsx   # galley proof stage 1
web/app/runs/[runId]/hitl2/page.tsx   # galley proof stage 2
web/components/ui/button.tsx          # variant overhaul, sharp 2px radius
web/components/ui/input.tsx           # bottom-rule only
web/components/ui/textarea.tsx        # bottom-rule only
web/components/ui/select.tsx          # paper-deep popover
web/components/ui/card.tsx            # drop default bg, add Editorial variant
web/components/RunStatusBadge.tsx     # paper-stamp treatment
web/components/CostMeter.tsx          # inline mono pill
web/components/EventTimeline.tsx      # ruled timeline with glyphs
web/components/LibraryTable.tsx       # ledger row treatment
web/components/RefreshFindingsPanel.tsx # editor's-brief blockquote
web/next.config.mjs                   # inject NEXT_PUBLIC_BUILD_SHA/DATE
```

---

## Task 1: Foundation — fonts, tokens, base styles

**Files:**
- Modify: `web/app/layout.tsx`
- Modify: `web/app/globals.css`

- [ ] **Step 1: Load Google Fonts via `next/font/google` in `web/app/layout.tsx`**

Replace the entire contents of `web/app/layout.tsx` with:

```tsx
import "./globals.css";

import { Fraunces, IBM_Plex_Sans, IBM_Plex_Mono, Noto_Sans_TC, Noto_Serif_TC } from "next/font/google";
import { Masthead } from "@/components/Masthead";
import { Folio } from "@/components/Folio";
import { Providers } from "./providers";

import type { ReactNode } from "react";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  axes: ["opsz", "SOFT"],
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

const notoSansTC = Noto_Sans_TC({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans-cjk",
  display: "swap",
});

const notoSerifTC = Noto_Serif_TC({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-display-cjk",
  display: "swap",
});

export default function RootLayout({ children }: { children: ReactNode }) {
  const fontVars = `${fraunces.variable} ${plexSans.variable} ${plexMono.variable} ${notoSansTC.variable} ${notoSerifTC.variable}`;
  return (
    <html lang="zh-Hant" className={fontVars}>
      <body className="min-h-screen bg-paper text-ink antialiased">
        <Providers>
          <Masthead />
          <Folio variant="top" />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Replace `web/app/globals.css` with the editorial token scheme**

Replace the entire contents of `web/app/globals.css` with:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  /* Editorial palette */
  --color-paper:        #F8F5EE;
  --color-paper-deep:   #EFE9DC;
  --color-ink:          #1A1714;
  --color-ink-soft:     #4A453E;
  --color-ink-faint:    #8B8275;
  --color-rule:         #D8D0BF;
  --color-accent:       #B0331E;
  --color-accent-deep:  #872416;
  --color-ok:           #2F6B3A;
  --color-warn:         #B27A0A;
  --color-info:         #3A5A8C;

  /* Font stacks (vars set by next/font in layout.tsx) */
  --font-sans:    var(--font-sans, "IBM Plex Sans"), var(--font-sans-cjk, "Noto Sans TC"), system-ui, sans-serif;
  --font-mono:    var(--font-mono, "IBM Plex Mono"), ui-monospace, "SFMono-Regular", monospace;
  --font-display: var(--font-display, "Fraunces"), var(--font-display-cjk, "Noto Serif TC"), ui-serif, Georgia, serif;
  --font-heading: var(--font-display);

  /* Radius scale */
  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 6px;
  --radius-xl: 8px;
  --radius-2xl: 12px;
  --radius: 6px;

  /* Re-map shadcn semantic tokens to editorial palette */
  --color-background: var(--color-paper);
  --color-foreground: var(--color-ink);
  --color-card: var(--color-paper);
  --color-card-foreground: var(--color-ink);
  --color-popover: var(--color-paper-deep);
  --color-popover-foreground: var(--color-ink);
  --color-primary: var(--color-ink);
  --color-primary-foreground: var(--color-paper);
  --color-secondary: var(--color-paper-deep);
  --color-secondary-foreground: var(--color-ink);
  --color-muted: var(--color-paper-deep);
  --color-muted-foreground: var(--color-ink-soft);
  --color-accent-foreground: var(--color-paper);
  --color-destructive: var(--color-accent);
  --color-border: var(--color-rule);
  --color-input: var(--color-rule);
  --color-ring: var(--color-accent);
}

:root {
  /* The @theme block above is the single source of truth.
     We keep an empty :root for any future runtime-only vars. */
}

@layer base {
  * { @apply border-rule outline-accent/40; }
  html { font-family: var(--font-sans); }
  body {
    background-color: var(--color-paper);
    color: var(--color-ink);
    /* Newsprint grain — single SVG turbulence at 1% opacity */
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.025 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  }
  /* Editorial body utilities used by SectionHead and review pages */
  .kicker {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--color-ink-faint);
  }
  .hed {
    font-family: var(--font-display);
    font-variation-settings: "opsz" 144, "SOFT" 80;
    font-weight: 500;
    line-height: 1.05;
    color: var(--color-ink);
  }
  .dek {
    font-family: var(--font-sans);
    font-size: 16px;
    color: var(--color-ink-soft);
    max-width: 65ch;
  }
}
```

- [ ] **Step 3: Run type-check to verify imports resolve**

Run: `cd web && npx tsc --noEmit`

Expected: a type error on `Masthead` and `Folio` because they don't exist yet. **This is fine — Task 2 creates them.** Note: the editor (`page.tsx` files) will fail too because Card/Button tokens changed; subsequent tasks fix each page.

- [ ] **Step 4: Commit**

```bash
git add web/app/layout.tsx web/app/globals.css
git commit -m "feat(web/foundation): editorial token scheme + Google Fonts loading"
```

---

## Task 2: Folio + Masthead primitives

**Files:**
- Create: `web/components/Folio.tsx`
- Create: `web/components/Masthead.tsx`

- [ ] **Step 1: Create `web/components/Folio.tsx`**

```tsx
import { cn } from "@/lib/utils";

/**
 * Two stacked ink rules — 2px solid above, 1px hairline 12px below.
 * Used at the very top of the page (variant="top") and as a section divider (variant="section").
 */
export function Folio({
  variant = "top",
  className,
}: {
  variant?: "top" | "section";
  className?: string;
}) {
  if (variant === "section") {
    return (
      <div className={cn("w-full", className)}>
        <div className="h-px bg-rule" />
      </div>
    );
  }
  return (
    <div className={cn("w-full", className)} aria-hidden>
      <div className="h-[2px] bg-ink" />
      <div className="h-3" />
      <div className="h-px bg-rule" />
    </div>
  );
}
```

- [ ] **Step 2: Create `web/components/Masthead.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Runs" },
  { href: "/library", label: "Library" },
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
          Bowtie · Content Desk
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
```

- [ ] **Step 3: Run type-check**

Run: `cd web && npx tsc --noEmit 2>&1 | head -40`

Expected: errors still present for Button variant `primary` (Task 5 fixes Button) and the existing pages. Focus only on errors inside `Masthead.tsx` / `Folio.tsx` — these two files should have **no** errors. The new utility colors (`bg-paper/85`, `text-ink`, `text-ink-soft`, `text-ink-faint`, `text-accent`, `bg-rule`, `bg-ink`, `font-display`, `font-mono`) come from the `@theme` block in Task 1 and are valid Tailwind v4 utilities.

- [ ] **Step 4: Commit**

```bash
git add web/components/Folio.tsx web/components/Masthead.tsx
git commit -m "feat(web/chrome): Folio + Masthead components"
```

---

## Task 3: SectionHead + PaperStamp primitives

**Files:**
- Create: `web/components/SectionHead.tsx`
- Create: `web/components/PaperStamp.tsx`

- [ ] **Step 1: Create `web/components/SectionHead.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionHeadProps {
  kicker?: ReactNode;
  hed: ReactNode;
  dek?: ReactNode;
  actions?: ReactNode;
  size?: "lg" | "md";
  className?: string;
}

export function SectionHead({ kicker, hed, dek, actions, size = "lg", className }: SectionHeadProps) {
  return (
    <header className={cn("flex items-end justify-between gap-6 mb-6", className)}>
      <div className="min-w-0 flex-1">
        {kicker ? <p className="kicker mb-2">{kicker}</p> : null}
        <h1
          className={cn(
            "hed",
            size === "lg" ? "text-[44px]" : "text-[28px]"
          )}
          style={{ fontVariationSettings: '"opsz" 144, "SOFT" 80' }}
        >
          {hed}
        </h1>
        {dek ? <p className="dek mt-3">{dek}</p> : null}
      </div>
      {actions ? <div className="shrink-0 pb-2">{actions}</div> : null}
    </header>
  );
}
```

- [ ] **Step 2: Create `web/components/PaperStamp.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "ok" | "warn" | "info" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "text-ink-soft",
  accent: "text-accent",
  ok: "text-ok",
  warn: "text-warn",
  info: "text-info",
  danger: "text-accent-deep",
};

interface PaperStampProps {
  tone?: Tone;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Newsroom-style paper stamp — uppercase mono small label inside a
 * 1px outlined rect that takes its ink color from the tone.
 */
export function PaperStamp({ tone = "neutral", pulse, children, className }: PaperStampProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 border border-current font-mono text-[10px] uppercase tracking-[0.12em] leading-none",
        TONE[tone],
        pulse && "animate-pulse",
        className
      )}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 3: Run type-check on the two new files**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -E "SectionHead|PaperStamp" || echo "OK: no errors in new files"`

Expected: `OK: no errors in new files`.

- [ ] **Step 4: Commit**

```bash
git add web/components/SectionHead.tsx web/components/PaperStamp.tsx
git commit -m "feat(web/chrome): SectionHead + PaperStamp primitives"
```

---

## Task 4: Build-info wiring

**Files:**
- Create: `web/lib/build-info.ts`
- Modify: `web/next.config.mjs`

- [ ] **Step 1: Update `web/next.config.mjs` to inject SHA and date**

Replace the entire contents with:

```js
import { execSync } from "node:child_process";

const apiBase = process.env.NEXT_PUBLIC_API_BASE;
if (!apiBase) {
  throw new Error("NEXT_PUBLIC_API_BASE is required (copy web/.env.local.example to web/.env.local)");
}

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function buildDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_SHA: gitSha(),
    NEXT_PUBLIC_BUILD_DATE: buildDate(),
  },
  async rewrites() {
    return [
      { source: "/api/runs/:path*", destination: `${apiBase}/runs/:path*` },
      { source: "/api/costs/:path*", destination: `${apiBase}/costs/:path*` },
      { source: "/api/health", destination: `${apiBase}/health` },
      { source: "/api/articles/:path*", destination: `${apiBase}/articles/:path*` },
      { source: "/api/refresh/:path*", destination: `${apiBase}/refresh/:path*` },
    ];
  },
};
export default nextConfig;
```

- [ ] **Step 2: Create `web/lib/build-info.ts`**

```ts
export const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";
export const BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE ?? "dev";
```

- [ ] **Step 3: Commit**

```bash
git add web/next.config.mjs web/lib/build-info.ts
git commit -m "feat(web/foundation): inject build SHA and date as env vars"
```

---

## Task 5: Button — editorial variants

**Files:**
- Modify: `web/components/ui/button.tsx`

- [ ] **Step 1: Replace `web/components/ui/button.tsx` entire contents**

```tsx
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center border whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 rounded-[2px] font-sans font-medium tracking-tight",
  {
    variants: {
      variant: {
        primary:
          "bg-ink text-paper border-ink hover:bg-accent hover:border-accent",
        secondary:
          "bg-transparent text-ink border-ink hover:bg-ink hover:text-paper",
        ghost:
          "bg-transparent text-ink border-transparent hover:border-b-ink rounded-none",
        destructive:
          "bg-transparent text-accent-deep border-accent-deep hover:bg-accent-deep hover:text-paper",
        // Legacy fallback so unmigrated callers don't break visually.
        default:
          "bg-ink text-paper border-ink hover:bg-accent hover:border-accent",
        outline:
          "bg-transparent text-ink border-ink hover:bg-ink hover:text-paper",
        link:
          "bg-transparent text-accent border-transparent hover:underline underline-offset-4",
      },
      size: {
        default: "h-9 px-3 text-[13px] gap-1.5",
        xs: "h-6 px-2 text-[11px] gap-1",
        sm: "h-7 px-2.5 text-[12px] gap-1",
        lg: "h-10 px-4 text-[14px] gap-2",
        icon: "size-9",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "primary",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
```

- [ ] **Step 2: Type-check buttons across all usages**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -E "button\\.tsx|variant=" | head -30`

Expected: no errors *inside* button.tsx; callers using `variant="default"`, `variant="outline"`, `variant="destructive"` still type-check because legacy variants are preserved.

- [ ] **Step 3: Commit**

```bash
git add web/components/ui/button.tsx
git commit -m "feat(web/ui): editorial Button variants (primary/secondary/ghost/destructive)"
```

---

## Task 6: Input + Textarea — bottom-rule treatment

**Files:**
- Modify: `web/components/ui/input.tsx`
- Modify: `web/components/ui/textarea.tsx`

- [ ] **Step 1: Replace `web/components/ui/input.tsx`**

```tsx
import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 bg-transparent text-[13px] text-ink",
        "border-0 border-b border-rule rounded-none px-0 py-1.5",
        "outline-none transition-colors",
        "placeholder:text-ink-faint",
        "focus-visible:border-b-2 focus-visible:border-accent focus-visible:pb-[5px]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "aria-invalid:border-accent-deep aria-invalid:focus-visible:border-accent-deep",
        className
      )}
      {...props}
    />
  )
}

export { Input }
```

- [ ] **Step 2: Replace `web/components/ui/textarea.tsx`**

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full bg-transparent text-[13px] text-ink",
        "border-0 border-b border-rule rounded-none px-0 py-1.5",
        "outline-none transition-colors resize-none",
        "placeholder:text-ink-faint",
        "focus-visible:border-b-2 focus-visible:border-accent focus-visible:pb-[5px]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "aria-invalid:border-accent-deep aria-invalid:focus-visible:border-accent-deep",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
```

- [ ] **Step 3: Commit**

```bash
git add web/components/ui/input.tsx web/components/ui/textarea.tsx
git commit -m "feat(web/ui): bottom-rule Input + Textarea treatment"
```

---

## Task 7: Select — paper-deep popover restyle

**Files:**
- Modify: `web/components/ui/select.tsx`

- [ ] **Step 1: Read `web/components/ui/select.tsx` first**

Run `Read` on the file to see its current shadcn/base-ui composition (it wraps `@base-ui/react/select`). Adjust only class strings; preserve all structure, props, refs, and slot data attributes.

- [ ] **Step 2: Restyle by replacing class strings only**

Apply these class changes:
- `SelectTrigger`: change to `"flex h-9 w-full items-center justify-between gap-2 border-0 border-b border-rule rounded-none bg-transparent px-0 py-1.5 text-[13px] text-ink outline-none transition-colors data-[placeholder]:text-ink-faint focus-visible:border-b-2 focus-visible:border-accent focus-visible:pb-[5px] disabled:opacity-50"`
- `SelectContent`: change rounded/shadow/bg classes to `"z-50 min-w-[var(--anchor-width)] overflow-hidden border border-rule bg-paper-deep text-ink shadow-[0_1px_0_0_rgba(26,23,20,0.06)] rounded-none"`
- `SelectItem`: change to `"relative flex w-full cursor-default select-none items-center px-3 py-1.5 text-[13px] outline-none data-[highlighted]:bg-paper data-[highlighted]:text-ink data-[disabled]:opacity-50"`
- `SelectSeparator`: `"mx-2 my-1 h-px bg-rule"`
- `SelectLabel`: `"px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint"`

Leave all imports, refs, and slot wiring intact.

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit 2>&1 | grep "select.tsx" || echo "OK"`

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add web/components/ui/select.tsx
git commit -m "feat(web/ui): paper-deep editorial Select popover"
```

---

## Task 8: Card — drop default bg + editorial variant

**Files:**
- Modify: `web/components/ui/card.tsx`

- [ ] **Step 1: Replace entire `web/components/ui/card.tsx`**

```tsx
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const cardVariants = cva("group/card flex flex-col gap-4 py-4 text-sm text-ink", {
  variants: {
    variant: {
      // Default: hairline-only frame on the paper surface
      default: "bg-transparent border border-rule rounded-[6px]",
      // Editorial: raised paper-deep surface, slightly tighter chrome
      editorial: "bg-paper-deep border border-rule rounded-[6px]",
      // Plain: no frame at all (used for sections that sit directly on paper)
      plain: "bg-transparent border-0 rounded-none",
    },
    size: {
      default: "py-4",
      sm: "py-3 gap-3",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
})

function Card({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      data-size={size ?? "default"}
      className={cn(cardVariants({ variant, size, className }))}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("@container/card-header grid auto-rows-min items-start gap-1 px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3", className)}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-display text-base leading-snug font-medium group-data-[size=sm]/card:text-sm", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-ink-soft", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4 group-data-[size=sm]/card:px-3", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center border-t border-rule px-4 py-3", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
  cardVariants,
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/ui/card.tsx
git commit -m "feat(web/ui): Card variants (default/editorial/plain), drop default bg"
```

---

## Task 9: RunStatusBadge — paper stamp

**Files:**
- Modify: `web/components/RunStatusBadge.tsx`

- [ ] **Step 1: Replace entire `web/components/RunStatusBadge.tsx`**

```tsx
import { PaperStamp } from "@/components/PaperStamp";

import type { RunStatus } from "@/lib/types";

type Tone = "neutral" | "accent" | "ok" | "warn" | "info" | "danger";

const TONE: Record<RunStatus, { tone: Tone; pulse?: boolean }> = {
  pending:            { tone: "neutral" },
  fetching:           { tone: "info", pulse: true },
  strategy:           { tone: "info", pulse: true },
  hitl_1:             { tone: "accent" },
  production:         { tone: "info", pulse: true },
  hitl_2:             { tone: "accent" },
  persisted:          { tone: "ok" },
  failed:             { tone: "danger" },
  cancelled:          { tone: "neutral" },
  rejected:           { tone: "danger" },
  changes_requested:  { tone: "warn" },
};

const LABEL: Partial<Record<RunStatus, string>> = {
  hitl_1: "HITL · 1",
  hitl_2: "HITL · 2",
  changes_requested: "CHANGES",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const { tone, pulse } = TONE[status] ?? { tone: "neutral" };
  const label = LABEL[status] ?? status.toUpperCase();
  return <PaperStamp tone={tone} pulse={pulse}>{label}</PaperStamp>;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/RunStatusBadge.tsx
git commit -m "feat(web/ui): RunStatusBadge as paper stamp"
```

---

## Task 10: CostMeter — inline mono pill

**Files:**
- Modify: `web/components/CostMeter.tsx`

- [ ] **Step 1: Replace entire `web/components/CostMeter.tsx`**

```tsx
"use client";
import { useQuery } from "@tanstack/react-query";

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function CostMeter({ runId }: { runId: string }) {
  const { data } = useQuery({
    queryKey: ["cost", runId],
    queryFn: async () => {
      const r = await fetch(`/api/costs/run/${runId}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      return (await r.json()) as {
        tokens_in: number;
        tokens_out: number;
        thinking_tokens: number;
        est_usd_cents: number;
      };
    },
    refetchInterval: 5000,
  });
  if (!data) return null;
  const totalTokens = data.tokens_in + data.tokens_out + data.thinking_tokens;
  // HK$ at 7.8 ~= USD; we show as HK$ since this is Bowtie/HK.
  const hk = (data.est_usd_cents / 100) * 7.8;
  return (
    <span className="font-mono text-[12px] text-ink-soft tabular-nums">
      HK$ {hk.toFixed(2)} · {formatTokens(totalTokens)} tok
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/CostMeter.tsx
git commit -m "feat(web/cost): inline mono pill (HK$ + total tokens)"
```

---

## Task 11: EventTimeline — ruled timeline with glyphs

**Files:**
- Modify: `web/components/EventTimeline.tsx`

- [ ] **Step 1: Replace entire `web/components/EventTimeline.tsx`**

```tsx
import type { SseEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

function glyphFor(event: string): { ch: string; tone: "ink" | "accent" | "danger" } {
  const e = event.toLowerCase();
  if (e.includes("error") || e.includes("fail")) return { ch: "✕", tone: "danger" };
  if (e.includes("hitl") || e.includes("human") || e.includes("await")) return { ch: "▴", tone: "accent" };
  return { ch: "▪", tone: "ink" };
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function EventTimeline({ events }: { events: SseEvent[] }) {
  if (events.length === 0) {
    return <p className="text-ink-faint italic font-display text-[15px]">No signal yet.</p>;
  }
  return (
    <ol className="relative">
      {events.map((e, i) => {
        const { ch, tone } = glyphFor(e.event);
        const last = i === events.length - 1;
        return (
          <li key={i} className="grid grid-cols-[72px_16px_1fr] gap-3 items-start py-2.5 border-b border-rule last:border-b-0">
            <span className="font-mono text-[11px] text-ink-faint tabular-nums pt-[2px]">
              {formatTime(e.timestamp)}
            </span>
            <span
              className={cn(
                "text-[12px] leading-none pt-[5px]",
                tone === "danger" && "text-accent-deep",
                tone === "accent" && "text-accent",
                tone === "ink" && "text-ink-soft",
                last && "animate-pulse"
              )}
              aria-hidden
            >
              {ch}
            </span>
            <div className="min-w-0">
              <p className="font-mono text-[12px] text-ink break-words">{e.event}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/EventTimeline.tsx
git commit -m "feat(web/run): ruled EventTimeline with status glyphs"
```

---

## Task 12: Runs list (`/`) — Front Page ledger

**Files:**
- Modify: `web/app/page.tsx`

- [ ] **Step 1: Replace entire `web/app/page.tsx`**

```tsx
"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { RunStatusBadge } from "@/components/RunStatusBadge";
import { SectionHead } from "@/components/SectionHead";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function ledgerDate(iso: string) {
  const d = new Date(iso);
  return {
    day: DAYS[d.getDay()],
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

export default function Home() {
  const { data, isLoading } = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns() });

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <SectionHead
        kicker="Runs · Live"
        hed="Front Page"
        dek="Articles currently in motion through the desk."
        actions={
          <Link href="/runs/new">
            <Button variant="secondary" size="sm">Start a new run →</Button>
          </Link>
        }
      />

      {isLoading && <p className="text-ink-faint">Loading…</p>}

      {data && data.length === 0 && (
        <p className="font-display italic text-ink-faint text-[18px] mt-12">No stories on the wire.</p>
      )}

      <ul className="border-t border-rule">
        {data?.map((r) => {
          const { day, time } = ledgerDate(r.created_at);
          return (
            <li key={r.run_id} className="border-b border-rule group">
              <Link
                href={`/runs/${r.run_id}`}
                className={cn(
                  "grid grid-cols-[96px_1fr_220px] gap-6 py-5 items-center",
                  "transition-colors hover:bg-paper-deep/60"
                )}
              >
                <div className="text-left">
                  <p className="font-mono text-[11px] text-ink-faint tracking-wider group-hover:text-accent transition-colors">{day}</p>
                  <p className="font-mono text-[14px] text-ink-soft tabular-nums">{time}</p>
                </div>
                <div className="min-w-0">
                  <p className="font-display text-[22px] leading-tight text-ink truncate" style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}>
                    {r.topic}
                  </p>
                  <div className="mt-2 h-px bg-rule" />
                  <p className="mt-2 font-sans text-[12px] text-ink-faint truncate">{r.article_url}</p>
                </div>
                <div className="flex items-center justify-end gap-3">
                  <RunStatusBadge status={r.status} />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Type-check the page**

Run: `cd web && npx tsc --noEmit 2>&1 | grep "app/page.tsx" || echo "OK"`

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add web/app/page.tsx
git commit -m "feat(web/runs): Front Page ledger layout"
```

---

## Task 13: Library page header + toolbar

**Files:**
- Modify: `web/app/library/page.tsx`

- [ ] **Step 1: Replace entire `web/app/library/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { refreshApi } from "@/lib/api";
import { LibraryTable } from "@/components/LibraryTable";
import { SectionHead } from "@/components/SectionHead";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function LibraryPage() {
  const [needsRefresh, setNeedsRefresh] = useState<boolean | undefined>(undefined);
  const [persona, setPersona] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"staleness" | "next_scan_due" | "last_persisted" | "">("");

  const scanMutation = useMutation({
    mutationFn: () => refreshApi.scanAll(),
    onSuccess: (r) => toast.success(`Scan complete — ${r.evaluations_created} evaluations created`),
    onError: (e: Error) => toast.error(e.message),
  });

  const filters = {
    needs_refresh: needsRefresh,
    persona: persona || undefined,
    q: q || undefined,
    sort: sort || undefined,
  } as {
    needs_refresh?: boolean;
    persona?: string;
    q?: string;
    sort?: "staleness" | "next_scan_due" | "last_persisted";
  };

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 space-y-8">
      <SectionHead
        kicker="Archive"
        hed="Article Library"
        dek="Every article we monitor, with the desk's latest evaluation. Re-scanned on the schedule and on demand."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
          >
            {scanMutation.isPending ? "Scanning…" : "Run scan now"}
          </Button>
        }
      />

      <div className="border-y border-rule py-4 grid grid-cols-1 md:grid-cols-4 gap-x-8 gap-y-4">
        <ToolbarField label="Status">
          <Select
            value={needsRefresh === undefined ? "all" : needsRefresh ? "needs_refresh" : "ok"}
            onValueChange={(v) => {
              if (v === "all") setNeedsRefresh(undefined);
              else if (v === "needs_refresh") setNeedsRefresh(true);
              else setNeedsRefresh(false);
            }}
          >
            <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="needs_refresh">Needs refresh</SelectItem>
              <SelectItem value="ok">OK</SelectItem>
            </SelectContent>
          </Select>
        </ToolbarField>

        <ToolbarField label="Persona">
          <Input placeholder="e.g. bowtie-editor" value={persona} onChange={(e) => setPersona(e.target.value)} />
        </ToolbarField>

        <ToolbarField label="Search">
          <Input placeholder="Topic or URL…" value={q} onChange={(e) => setQ(e.target.value)} />
        </ToolbarField>

        <ToolbarField label="Sort">
          <Select value={sort || "staleness"} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger><SelectValue placeholder="Sort by…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="staleness">Staleness</SelectItem>
              <SelectItem value="next_scan_due">Next scan due</SelectItem>
              <SelectItem value="last_persisted">Last persisted</SelectItem>
            </SelectContent>
          </Select>
        </ToolbarField>
      </div>

      <LibraryTable filters={filters} />
    </div>
  );
}

function ToolbarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="kicker">{label}</label>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/library/page.tsx
git commit -m "feat(web/library): archive header + flat toolbar"
```

---

## Task 14: LibraryTable — ledger row treatment

**Files:**
- Modify: `web/components/LibraryTable.tsx`

- [ ] **Step 1: Read the current `web/components/LibraryTable.tsx`**

The table preserves all behavior (drawer, dismiss dropdown, dot color, staleness indicator, pagination) — we restyle only the table chrome, headers, and row presentation.

- [ ] **Step 2: Apply these class string changes (preserve all structure, hooks, mutations, refs)**

Change the table container `<div className="overflow-x-auto rounded-lg border bg-white">` to:
```tsx
<div className="overflow-x-auto border-t border-b border-rule">
```

Change the `<table>` className from `"w-full text-sm"` to `"w-full text-[13px]"`.

Change the `<thead>` `<tr>` className from `"border-b bg-neutral-50 text-left text-xs text-muted-foreground"` to:
```
"border-b border-rule text-left font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint"
```

Change every `<th className="px-3 py-2 ...">` to `<th className="px-3 py-3 ...">`.

Change body `<tr>` className from `"border-b last:border-0 hover:bg-neutral-50 cursor-pointer transition-colors"` to:
```
"border-b border-rule last:border-b-0 cursor-pointer transition-colors hover:bg-paper-deep/60 group"
```

Change every body `<td className="px-3 py-2 ...">` to use `py-3` instead of `py-2`. Specific column tweaks:
- "Topic / URL" cell: change `<p className="font-medium line-clamp-1">` to `<p className="font-display text-[15px] text-ink line-clamp-1" style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}>`. Change link `"text-xs text-blue-700 underline break-all line-clamp-1"` to `"font-mono text-[11px] text-ink-faint underline-offset-2 hover:underline break-all line-clamp-1"`.
- "Persona" cell: change `text-muted-foreground` to `text-ink-soft font-mono text-[12px]`.
- "Last persisted" cell: change `text-muted-foreground` to `text-ink-soft font-mono text-[12px] tabular-nums`.
- "Top reason" cell: change `text-muted-foreground line-clamp-2 text-xs` to `text-ink-soft line-clamp-2 text-[12px]`.

Change the small dot:
```tsx
<span className={`inline-block h-2.5 w-2.5 rounded-full ${dotColor(action)}`} />
```
to:
```tsx
<span aria-hidden className={cn("inline-block leading-none text-[14px]", dotColorStamp(action))}>▪</span>
```

Update the `dotColor` helper to:
```ts
function dotColorStamp(action: string | undefined) {
  if (action === "refresh") return "text-accent";
  if (action === "monitor") return "text-warn";
  return "text-ink-faint";
}
```
(Remove the old `dotColor` function.)

Change the "Trigger" link className from:
```
"inline-flex h-7 items-center rounded-lg border border-border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted"
```
to:
```
"inline-flex h-7 items-center border border-ink bg-transparent text-ink px-2.5 text-[11px] font-medium transition-colors hover:bg-ink hover:text-paper rounded-[2px]"
```

Change the Dismiss dropdown trigger Button: `<Button size="sm" variant="ghost" className="h-7 text-xs">Dismiss ▾</Button>` to `<Button size="sm" variant="ghost" className="h-7 text-[11px]">Dismiss ▾</Button>`.

Change the pagination block:
```tsx
<div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
  <span>{from}–{to} of {total}</span>
  <div className="flex gap-2">
    <Button size="sm" variant="outline" ...>Prev</Button>
    <Button size="sm" variant="outline" ...>Next</Button>
  </div>
</div>
```
to:
```tsx
<div className="mt-4 flex items-center justify-between font-mono text-[12px] text-ink-soft tabular-nums">
  <span>{String(from).padStart(2, "0")} — {String(to).padStart(2, "0")} OF {String(total).padStart(2, "0")}</span>
  <div className="flex gap-2">
    <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>← Prev</Button>
    <Button size="sm" variant="secondary" disabled={to >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next →</Button>
  </div>
</div>
```

Change loading/error blocks:
- Loading: `<div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>` → `<div className="py-12 text-center text-ink-faint text-[13px]">Loading…</div>`
- Error: `<div className="py-12 text-center text-destructive text-sm">Failed to load articles.</div>` → `<div className="py-12 text-center text-accent-deep text-[13px]">Failed to load articles.</div>`

Empty row: change `"px-3 py-10 text-center text-muted-foreground"` to `"px-3 py-12 text-center font-display italic text-ink-faint text-[16px]"` and the text from `"No articles found."` to `"Nothing to file in the archive."`.

Ensure `cn` is imported from `"@/lib/utils"` at the top.

- [ ] **Step 3: Commit**

```bash
git add web/components/LibraryTable.tsx
git commit -m "feat(web/library): ledger-row treatment for LibraryTable"
```

---

## Task 15: RefreshFindingsPanel — editor's brief

**Files:**
- Modify: `web/components/RefreshFindingsPanel.tsx`

- [ ] **Step 1: Replace entire `web/components/RefreshFindingsPanel.tsx`**

```tsx
import { PaperStamp } from "@/components/PaperStamp";
import { cn } from "@/lib/utils";
import type { RefreshEvaluation } from "@/lib/types";

interface RefreshFindingsPanelProps {
  ev: RefreshEvaluation;
  className?: string;
}

const SEVERITY_TONE = {
  high: "danger",
  medium: "warn",
  low: "neutral",
} as const;

const SEVERITY_LABEL = {
  high: "HIGH",
  medium: "MED",
  low: "LOW",
} as const;

export function RefreshFindingsPanel({ ev, className }: RefreshFindingsPanelProps) {
  const { deterministic_findings, llm_findings, llm_skipped_reason } = ev;
  const findings = deterministic_findings?.findings ?? [];

  const actionTone =
    ev.recommended_action === "refresh" ? "accent" :
    ev.recommended_action === "monitor" ? "warn" :
    "neutral";

  return (
    <blockquote className={cn("border-l-2 border-accent pl-5 space-y-5 text-[13px]", className)}>
      <p className="kicker">Brief from Archive</p>

      <div className="flex flex-wrap gap-3 items-center font-mono text-[12px] text-ink-soft">
        <span>STALENESS · <span className="text-ink tabular-nums">{Number(ev.staleness_score).toFixed(1)}</span></span>
        <span className="text-ink-faint">·</span>
        <PaperStamp tone={actionTone}>{ev.recommended_action}</PaperStamp>
        <span className="text-ink-faint">·</span>
        <span>AGE · <span className="text-ink tabular-nums">{ev.age_days}d</span></span>
      </div>

      <section>
        <p className="kicker mb-3">
          Deterministic findings · {deterministic_findings?.severity_high ?? 0}H · {deterministic_findings?.severity_medium ?? 0}M · {deterministic_findings?.severity_low ?? 0}L
        </p>
        {findings.length === 0 ? (
          <p className="text-ink-faint italic font-display">No findings.</p>
        ) : (
          <ol className="space-y-2.5 list-none">
            {findings.map((f, i) => (
              <li key={f.id} className="grid grid-cols-[28px_56px_1fr] gap-3 items-start">
                <span className="font-mono text-[12px] text-ink-faint tabular-nums pt-[2px]">{String(i + 1).padStart(2, "0")}.</span>
                <PaperStamp tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</PaperStamp>
                <span className="text-ink">{f.message}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <p className="kicker mb-2">LLM audit</p>
        {llm_skipped_reason ? (
          <p className="text-ink-faint text-[12px]">Skipped: {llm_skipped_reason}</p>
        ) : llm_findings ? (
          <pre className="bg-paper-deep p-3 text-[11px] font-mono overflow-auto max-h-48 whitespace-pre-wrap border border-rule">
            {JSON.stringify(llm_findings, null, 2)}
          </pre>
        ) : (
          <p className="text-ink-faint text-[12px]">No LLM findings.</p>
        )}
      </section>
    </blockquote>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/RefreshFindingsPanel.tsx
git commit -m "feat(web/refresh): editor's-brief blockquote for RefreshFindingsPanel"
```

---

## Task 16: New run — Assignment Sheet

**Files:**
- Modify: `web/app/runs/new/page.tsx`

- [ ] **Step 1: Replace entire `web/app/runs/new/page.tsx`**

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SectionHead } from "@/components/SectionHead";
import { RefreshFindingsPanel } from "@/components/RefreshFindingsPanel";
import { api, articlesApi, refreshApi } from "@/lib/api";
import type { CreateRunRequest } from "@/lib/types";

const DEFAULT_FORM: CreateRunRequest = {
  article_url: "", topic: "", keywords: [],
  mode: "auto", edit_note: null,
  acf_adv_id: 1, acf_widget_id: 1,
  persona: "bowtie-editor", topic_category: null,
  editor_email: process.env.NEXT_PUBLIC_DEFAULT_EDITOR_EMAIL ?? "",
  triggered_by_evaluation_id: null,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="kicker">{label}</label>
      {children}
    </div>
  );
}

export default function NewRunPage() {
  const router = useRouter();
  const params = useSearchParams();
  const articleId = params.get("article_id");
  const evaluationId = params.get("evaluation_id");

  const [form, setForm] = useState<CreateRunRequest>(DEFAULT_FORM);
  const [keywordsRaw, setKeywordsRaw] = useState("");
  const seeded = useRef(false);

  const { data: article } = useQuery({
    queryKey: ["article", articleId],
    queryFn: () => articleId ? articlesApi.detail(articleId) : Promise.resolve(null),
    enabled: !!articleId,
  });

  const { data: evaluation } = useQuery({
    queryKey: ["evaluation", evaluationId],
    queryFn: () => evaluationId ? refreshApi.getEvaluation(evaluationId) : Promise.resolve(null),
    enabled: !!evaluationId,
  });

  const articleReady = !articleId || article !== undefined;
  const evaluationReady = !evaluationId || evaluation !== undefined;
  useEffect(() => {
    if (seeded.current) return;
    if (!articleReady || !evaluationReady) return;
    if (!article && !evaluation) return;
    seeded.current = true;
    const next = { ...DEFAULT_FORM };
    if (article) {
      next.article_url = article.article_url;
      next.persona = article.persona ?? DEFAULT_FORM.persona;
      next.topic = article.topic ?? DEFAULT_FORM.topic;
      next.topic_category = article.topic_category ?? DEFAULT_FORM.topic_category;
    }
    if (evaluation) {
      next.mode = evaluation.deterministic_findings.severity_high > 0
        ? "full_rewrite"
        : "small_refresh";
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(next);
  }, [articleReady, evaluationReady, article, evaluation]);

  const mutation = useMutation({
    mutationFn: () => api.createRun({
      ...form,
      keywords: keywordsRaw.split(",").map(s => s.trim()).filter(Boolean),
      triggered_by_evaluation_id: evaluationId ?? undefined,
    }),
    onSuccess: (r) => router.push(`/runs/${r.run_id}`),
  });

  return (
    <div className="mx-auto max-w-[760px] px-5 md:px-10 py-10 space-y-8">
      <SectionHead
        kicker="New Run"
        hed="Article Assignment"
        dek="Brief the desk on the next refresh."
        size="md"
      />

      {evaluation && (
        <RefreshFindingsPanel ev={evaluation} />
      )}

      {article && !evaluation && (
        <blockquote className="border-l-2 border-accent pl-5 space-y-2 text-[13px]">
          <p className="kicker">Brief from Archive</p>
          <p className="font-display text-[18px] text-ink leading-snug">{article.topic ?? "(no topic)"}</p>
          <a href={article.article_url} target="_blank" rel="noopener noreferrer"
             className="font-mono text-[11px] text-ink-faint underline-offset-2 hover:underline break-all line-clamp-1">
            {article.article_url}
          </a>
          <p className="font-mono text-[11px] text-ink-soft">
            OPEN RUNS · <span className="tabular-nums">{article.open_runs_count}</span>
            {article.last_persisted_at && <> · LAST PERSISTED {new Date(article.last_persisted_at).toLocaleDateString()}</>}
          </p>
        </blockquote>
      )}

      <Card variant="editorial" className="px-6 py-6 space-y-6">
        <Field label="Article URL">
          <Input value={form.article_url} onChange={(e) => setForm({ ...form, article_url: e.target.value })}
                 placeholder="https://www.bowtie.com.hk/blog/zh/..." />
        </Field>
        <Field label="Topic">
          <Input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} />
        </Field>
        <Field label="Focus keywords (comma-separated)">
          <Input value={keywordsRaw} onChange={(e) => setKeywordsRaw(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-6">
          <Field label="Mode">
            <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as CreateRunRequest["mode"] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="small_refresh">Small refresh</SelectItem>
                <SelectItem value="full_rewrite">Full rewrite</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Persona">
            <Input value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-6">
          <Field label="acf_adv_id">
            <Input type="number" value={form.acf_adv_id}
                   onChange={(e) => setForm({ ...form, acf_adv_id: parseInt(e.target.value || "0", 10) })} />
          </Field>
          <Field label="acf_widget_id">
            <Input type="number" value={form.acf_widget_id}
                   onChange={(e) => setForm({ ...form, acf_widget_id: parseInt(e.target.value || "0", 10) })} />
          </Field>
        </div>
        <Field label="Topic category (optional)">
          <Input value={form.topic_category ?? ""} onChange={(e) => setForm({ ...form, topic_category: e.target.value || null })}
                 placeholder="community-response / patient-experience / social-discussion" />
        </Field>
        <Field label="Edit note (optional)">
          <Textarea value={form.edit_note ?? ""} onChange={(e) => setForm({ ...form, edit_note: e.target.value || null })} />
        </Field>
        <Field label="Editor email">
          <Input value={form.editor_email} onChange={(e) => setForm({ ...form, editor_email: e.target.value })} />
        </Field>
        <div className="flex items-center justify-end gap-4 pt-2">
          <Link href="/" className="text-[12px] text-ink-soft hover:text-ink">Cancel ↩</Link>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Start run →"}
          </Button>
        </div>
        {mutation.isError && <p className="text-accent-deep text-[12px]">{(mutation.error as Error).message}</p>}
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/runs/new/page.tsx
git commit -m "feat(web/runs/new): Assignment Sheet form layout"
```

---

## Task 17: Run detail — Story Page

**Files:**
- Modify: `web/app/runs/[runId]/page.tsx`

- [ ] **Step 1: Replace entire `web/app/runs/[runId]/page.tsx`**

```tsx
"use client";
import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { SectionHead } from "@/components/SectionHead";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { EventTimeline } from "@/components/EventTimeline";
import { CostMeter } from "@/components/CostMeter";
import { useRunEvents } from "@/lib/sse";
import { api } from "@/lib/api";

export default function RunDetail({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const { data: run } = useQuery({
    queryKey: ["run", runId], queryFn: () => api.getRun(runId),
    refetchInterval: 3000,
  });
  const events = useRunEvents(runId);

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <div className="mb-4">
        <Link href="/" className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider">
          ← All runs
        </Link>
      </div>

      <SectionHead
        kicker={<>Run · <span className="text-accent">{shortId}</span></>}
        hed={run?.topic ?? "…"}
        dek={
          run?.article_url ? (
            <a href={run.article_url} target="_blank" rel="noopener noreferrer" className="hover:text-ink hover:underline underline-offset-2 break-all">
              {run.article_url} <span className="text-ink-faint">↗</span>
            </a>
          ) : null
        }
      />

      {/* Byline strip */}
      <div className="font-mono text-[12px] text-ink-soft border-y border-rule py-3 mb-8 flex flex-wrap items-center gap-x-3 gap-y-2">
        {run && (
          <>
            <span className="inline-flex items-center gap-2">
              STATUS · <RunStatusBadge status={run.status} />
            </span>
            <span className="text-ink-faint">·</span>
            {run.chosen_route && (
              <>
                <span>ROUTE · <span className="text-ink">{run.chosen_route}</span></span>
                <span className="text-ink-faint">·</span>
              </>
            )}
            <span>ITER · <span className="text-ink tabular-nums">{run.iteration_count}</span></span>
            <span className="text-ink-faint">·</span>
            <CostMeter runId={runId} />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-10">
        {/* Live progress */}
        <section>
          <p className="kicker mb-3">Live progress</p>
          <EventTimeline events={events} />
        </section>

        {/* Editor's actions */}
        <aside className="lg:sticky lg:top-32 self-start">
          <p className="kicker mb-3">Editor's actions</p>
          <div className="space-y-3">
            {run?.status === "hitl_1" && (
              <div>
                <p className="kicker mb-2">Hitl · Stage 1</p>
                <Link href={`/runs/${runId}/hitl1`} className="block">
                  <Button variant="primary" size="lg" className="w-full">Review gap analysis & outline →</Button>
                </Link>
              </div>
            )}
            {run?.status === "hitl_2" && (
              <div>
                <p className="kicker mb-2">Hitl · Stage 2</p>
                <Link href={`/runs/${runId}/hitl2`} className="block">
                  <Button variant="primary" size="lg" className="w-full">Review final draft →</Button>
                </Link>
              </div>
            )}
            {run && run.status !== "hitl_1" && run.status !== "hitl_2" && (
              <p className="font-display italic text-ink-faint text-[15px]">Nothing required of the desk.</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/runs/[runId]/page.tsx
git commit -m "feat(web/runs/detail): Story Page with byline strip + editor's actions"
```

---

## Task 18: HITL1 — Galley Proof Stage 1

**Files:**
- Modify: `web/app/runs/[runId]/hitl1/page.tsx`

- [ ] **Step 1: Replace entire `web/app/runs/[runId]/hitl1/page.tsx`**

```tsx
"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHead } from "@/components/SectionHead";
import { GapAnalysisView } from "@/components/GapAnalysisView";
import { OutlineEditor } from "@/components/OutlineEditor";
import { api } from "@/lib/api";
import type { Outline } from "@/lib/types";

export default function Hitl1Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();
  const ga = useQuery({ queryKey: ["ga", runId], queryFn: () => api.getGapAnalysis(runId) });
  const ol = useQuery({ queryKey: ["outline", runId], queryFn: () => api.getOutline(runId) });
  const [edited, setEdited] = useState<Outline | null>(null);

  const approve = useMutation({
    mutationFn: () => api.resumeHitl1(runId, edited ? { decision: "edit_outline", edited_outline: edited } : { decision: "approve" }),
    onSuccess: () => router.push(`/runs/${runId}`),
  });
  const overrideRoute = useMutation({
    mutationFn: (newRoute: "small_refresh" | "full_rewrite") =>
      api.resumeHitl1(runId, { decision: "override_route", new_route: newRoute }),
    onSuccess: () => router.push(`/runs/${runId}`),
  });

  const outline = edited ?? ol.data?.payload ?? null;

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 pb-32">
      <div className="mb-4">
        <Link href={`/runs/${runId}`} className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider">
          ← Run · {shortId}
        </Link>
      </div>

      <SectionHead
        kicker={<>Galley Proof · Stage 1 · <span className="text-accent">{shortId}</span></>}
        hed="Editor's review"
        dek="Confirm the gap analysis and approve the proposed outline — or override the route."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        <section>
          <p className="kicker mb-3">Gap analysis</p>
          {ga.data && <GapAnalysisView ga={ga.data} />}
        </section>
        <section>
          <p className="kicker mb-3">Outline (editable)</p>
          {outline && <OutlineEditor outline={outline} onChange={setEdited} />}
        </section>
      </div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 bg-paper/95 backdrop-blur border-t border-ink z-40">
        <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-3 flex items-center justify-between gap-4">
          <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">
            {edited ? "EDITS PENDING" : "AWAITING DECISION"}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => overrideRoute.mutate("small_refresh")}>Force small_refresh</Button>
            <Button variant="secondary" size="sm" onClick={() => overrideRoute.mutate("full_rewrite")}>Force full_rewrite</Button>
            <Button variant="primary" onClick={() => approve.mutate()}>
              {edited ? "Approve with edits ↪" : "Approve ↪"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/runs/[runId]/hitl1/page.tsx
git commit -m "feat(web/hitl1): Galley Proof Stage 1 with sticky action bar"
```

---

## Task 19: HITL2 — Galley Proof Stage 2

**Files:**
- Modify: `web/app/runs/[runId]/hitl2/page.tsx`

- [ ] **Step 1: Replace entire `web/app/runs/[runId]/hitl2/page.tsx`**

```tsx
"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionHead } from "@/components/SectionHead";
import { PaperStamp } from "@/components/PaperStamp";
import { TipTapEditor } from "@/components/TipTapEditor";
import { HtmlDiffView } from "@/components/HtmlDiffView";
import { WordPressMetaForm } from "@/components/WordPressMetaForm";
import { api } from "@/lib/api";
import type { Hitl2Request } from "@/lib/types";

export default function Hitl2Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();

  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });
  const audit = useQuery({ queryKey: ["audit", runId], queryFn: () => api.getLatestAudit(runId) });

  const [html, setHtml] = useState<string>("");
  const [form, setForm] = useState<Hitl2Request>({ decision: "approve", wp_publish_status: "draft" });
  const [originalHtml, setOriginalHtml] = useState("");

  useEffect(() => {
    if (render.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHtml(render.data.html_body);
      setOriginalHtml(render.data.html_body);
      setForm((f) => ({
        ...f,
        edited_seo_title: render.data!.seo_title,
        edited_meta_description: render.data!.meta_description,
        wp_excerpt: render.data!.excerpt_suggestion,
      }));
    }
  }, [render.data]);

  const submit = useMutation({
    mutationFn: (decision: Hitl2Request["decision"]) =>
      api.resumeHitl2(runId, { ...form, decision, edited_html_body: html }),
    onSuccess: () => router.push(`/runs/${runId}`),
  });

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 pb-32">
      <div className="mb-4">
        <Link href={`/runs/${runId}`} className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider">
          ← Run · {shortId}
        </Link>
      </div>

      <SectionHead
        kicker={<>Galley Proof · Stage 2 · <span className="text-accent">{shortId}</span></>}
        hed="Editor's review"
        dek="Final pass on the draft. Approve and push to WordPress as draft, request changes, or reject."
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
        {/* Galley column */}
        <section>
          <Tabs defaultValue="edit">
            <TabsList className="border-b border-rule">
              <TabsTrigger value="edit">Edit</TabsTrigger>
              <TabsTrigger value="diff">Diff vs render</TabsTrigger>
              <TabsTrigger value="audit">Audit findings</TabsTrigger>
            </TabsList>
            <TabsContent value="edit" className="pt-6">
              <div className="max-w-[65ch] mx-auto font-display text-[18px] leading-[1.65] text-ink" style={{ fontVariationSettings: '"opsz" 14, "SOFT" 60' }}>
                <TipTapEditor value={html} onChange={setHtml} />
              </div>
            </TabsContent>
            <TabsContent value="diff" className="pt-6">
              <HtmlDiffView original={originalHtml} updated={html} />
            </TabsContent>
            <TabsContent value="audit" className="pt-6">
              {audit.data && (
                <div className="space-y-3 text-[13px]">
                  <p className="font-mono text-[12px]">
                    OVERALL · <span className={audit.data.overall_pass ? "text-ok" : "text-accent-deep"}>{audit.data.overall_pass ? "PASS ✓" : "FAIL ✗"}</span>
                    {"  "}·  HIGH <span className="tabular-nums">{audit.data.severity_high}</span>
                    {"  "}·  MED <span className="tabular-nums">{audit.data.severity_medium}</span>
                    {"  "}·  LOW <span className="tabular-nums">{audit.data.severity_low}</span>
                  </p>
                  <ol className="space-y-3">
                    {[...audit.data.llm_findings.findings, ...audit.data.deterministic_findings.findings].map((f) => (
                      <li key={f.id} className="border-l-2 border-rule pl-4 py-1">
                        <div className="flex items-center gap-2 mb-1">
                          <PaperStamp tone={f.severity === "high" ? "danger" : f.severity === "medium" ? "warn" : "neutral"}>{f.severity}</PaperStamp>
                          <span className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">{f.category} · {f.location}</span>
                        </div>
                        <p className="text-ink">{f.issue}</p>
                        <p className="text-ink-soft text-[12px] mt-1">→ {f.suggested_fix}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </section>

        {/* WP metadata column */}
        <aside className="lg:sticky lg:top-32 self-start">
          <p className="kicker mb-3">WordPress metadata</p>
          <Card variant="editorial" className="px-5 py-5">
            <WordPressMetaForm form={form} onChange={setForm} />
          </Card>
        </aside>
      </div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 bg-paper/95 backdrop-blur border-t border-ink z-40">
        <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-3 flex items-center justify-end gap-2">
          <Button variant="destructive" size="sm" onClick={() => submit.mutate("reject")}>Reject ✕</Button>
          <Button variant="secondary" size="sm" onClick={() => submit.mutate("request_changes")}>Request changes ↺</Button>
          <Button variant="primary" onClick={() => submit.mutate("approve")} disabled={submit.isPending}>
            Approve & push to WP ↪
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/runs/[runId]/hitl2/page.tsx
git commit -m "feat(web/hitl2): Galley Proof Stage 2 + sticky action bar"
```

---

## Task 20: Footer + final verification

**Files:**
- Modify: `web/app/layout.tsx` (add footer)
- Modify: `web/tests/**` (only if Playwright selectors break)

- [ ] **Step 1: Add the footer to `web/app/layout.tsx`**

Update `web/app/layout.tsx` so the body wraps the main and a footer with build info. Replace the current `<main>{children}</main>` block with:

```tsx
<main className="pb-24">{children}</main>
<footer className="mx-auto max-w-[1180px] px-5 md:px-10 pt-8 pb-10">
  <div className="border-t border-rule pt-4">
    <p className="text-center font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">
      Bowtie Content Desk · Internal · Commit{" "}
      <span className="text-ink-soft">{process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev"}</span>
      {" · Built "}
      <span className="text-ink-soft">{process.env.NEXT_PUBLIC_BUILD_DATE ?? "dev"}</span>
    </p>
  </div>
</footer>
```

- [ ] **Step 2: Run full type-check**

Run: `cd web && npx tsc --noEmit`

Expected: **clean** — no errors.

If errors remain, fix them inline before continuing. Common likely fixes:
- Any caller still using a removed Button variant: change to `primary` / `secondary`.
- Any caller using `<Card>` expecting a background: pass `variant="editorial"` if it should have a raised surface, or leave default for hairline.

- [ ] **Step 3: Run lint**

Run: `cd web && npm run lint`

Expected: passes (or warnings only). Fix any errors.

- [ ] **Step 4: Start dev server and walk through each page**

Run in background: `cd web && npm run dev` (port 3000 by default).

Open each page in a browser (preview tools or local) and verify rendering:
1. `/` — masthead visible with dateline, Front Page hed shows, runs render as ledger rows.
2. `/library` — Archive hed, toolbar with 4 fields, table with mono headers, ledger rows.
3. `/runs/new` — Assignment Sheet form, bottom-rule inputs, Start run button.
4. `/runs/<existing_run_id>` (if any exists; otherwise create one) — byline strip, EventTimeline, editor's actions.
5. `/runs/<run_id>/hitl1` — Galley Proof Stage 1, sticky action bar.
6. `/runs/<run_id>/hitl2` — Galley Proof Stage 2, sticky action bar, body in Fraunces.

For each page, also check console for hydration warnings or React errors. The Masthead's dateline is intentionally rendered after hydration to avoid SSR/CSR mismatch on `new Date()`.

- [ ] **Step 5: Run Playwright tests**

Run: `cd web && npx playwright test`

Expected: passes. If any test fails due to changed selectors:
- Identify the assertion that broke (text content, class, role).
- Update the test selector to match the new DOM. Do NOT relax assertions; replace with equivalent selectors.
- The two existing Playwright tests are `tests/library.spec.ts` and `tests/runs-new.spec.ts` (per the recent commit `f0e46cf`). Common breaks expected: button labels (`Run scan now` → unchanged; `Start run` → now `Start run →`); the `Cancel ↩` link is new on `/runs/new`.

- [ ] **Step 6: Final commit**

```bash
git add web/app/layout.tsx web/tests/
git commit -m "feat(web): footer with build info + test selector updates"
```

- [ ] **Step 7: Final summary commit (optional)**

If there are stray formatting changes from your editor, stage and commit them with a clear message. Otherwise skip.

---

## Self-Review

**Spec coverage:**
- §2.1 Typography → Task 1
- §2.2 Color tokens → Task 1
- §2.3 Spacing / radius → Task 1 (radius scale in `@theme`)
- §2.4 Motion → row hover (Task 12/14), pulse on running status (Task 9), pulse on last timeline event (Task 11). Note: 12-line staggered page-enter animation deferred — keep optional, can be added later with no behavior impact.
- §2.5 Atmosphere (grain) → Task 1
- §3.1 Masthead → Task 2
- §3.2 Page shell + kicker/hed/dek → Task 3 (SectionHead) + globals.css base utilities
- §3.3 Footer → Task 20
- §4.1 Runs list → Task 12
- §4.2 Library → Tasks 13 + 14
- §4.3 New run → Task 16
- §4.4 Run detail → Task 17
- §4.5 HITL1/HITL2 → Tasks 18 + 19
- §5 Shared component refresh → Tasks 5–11

**Placeholder scan:** No TBDs / TODOs in the plan; every step has actual code or actual class strings.

**Type consistency:** Button `variant` keeps legacy strings (`default`, `outline`, `destructive`, `link`) alongside new (`primary`, `secondary`, `ghost`) so existing callers don't break. Card `variant` prop is new; default behavior changes (no bg) which is intentional — every page that needs a raised surface explicitly passes `variant="editorial"`. PaperStamp's `tone` union (`neutral|accent|ok|warn|info|danger`) is consistent across RunStatusBadge (Task 9) and RefreshFindingsPanel (Task 15) and HITL2 (Task 19).

**Scope:** This is a single cohesive redesign sitting on top of a stable feature set. Appropriate as one plan.
