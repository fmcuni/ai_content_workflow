"use client";

import Link, { useLinkStatus } from "next/link";
import type { ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NavLinkButtonProps extends VariantProps<typeof buttonVariants> {
  href: string;
  className?: string;
  children: ReactNode;
  /** Label shown while the route transition is in flight. */
  pendingLabel?: string;
}

/**
 * A `next/link` styled as a button that shows immediate "in flight" feedback
 * while the (often heavy) destination route loads. Without this, clicking a
 * link-styled button looks dead until the next page paints, prompting users to
 * click again. `useLinkStatus` must run inside a descendant of `<Link>`.
 */
function PendingContent({
  children,
  pendingLabel,
}: {
  children: ReactNode;
  pendingLabel: string;
}) {
  const { pending } = useLinkStatus();
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center gap-1.5",
        pending && "opacity-70",
      )}
    >
      {pending ? <>↻ {pendingLabel}</> : children}
    </span>
  );
}

export function NavLinkButton({
  href,
  variant,
  size,
  className,
  children,
  pendingLabel = "Opening…",
}: NavLinkButtonProps) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant, size }), className)}>
      <PendingContent pendingLabel={pendingLabel}>{children}</PendingContent>
    </Link>
  );
}
