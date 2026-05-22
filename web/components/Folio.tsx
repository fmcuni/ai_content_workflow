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
