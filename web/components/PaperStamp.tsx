import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "ok" | "warn" | "info" | "danger";

// Tone → ink color. `danger` deliberately reuses the deeper accent shade rather
// than introducing a separate red, keeping the palette to a single editorial accent.
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
