"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { Capability, Role } from "@/lib/roles";
import { useRole } from "@/lib/use-role";

interface RoleGateProps {
  /** Capability or minimum role the operator needs to see `children`. */
  need: Role | Capability;
  children: ReactNode;
  /** Rendered when the operator lacks `need`. Defaults to nothing (hidden). */
  fallback?: ReactNode;
}

/**
 * Hides `children` unless the operator's role satisfies `need`. Use for primary
 * action controls a role simply cannot use — hiding avoids dead buttons. While
 * the role is still resolving we render nothing to avoid a flash of an action
 * the operator may not have.
 */
export function RoleGate({ need, children, fallback = null }: RoleGateProps) {
  const { can, isLoading } = useRole();
  if (isLoading) return <>{fallback}</>;
  return <>{can(need) ? children : fallback}</>;
}

type ButtonProps = React.ComponentProps<typeof Button>;

interface RoleButtonProps extends ButtonProps {
  /** Capability or minimum role required to enable this button. */
  need: Role | Capability;
  /** Hint shown (as a tooltip) when the role can't use this control. */
  deniedHint?: string;
}

/**
 * A shadcn Button that disables itself (with a tooltip hint) when the operator's
 * role doesn't satisfy `need`. Use where hiding the control would confuse the
 * layout or hide context the operator should still see. The button's own
 * `disabled`/`title` are preserved and combined with the role gate.
 */
export function RoleButton({
  need,
  deniedHint = "Your role can't perform this action.",
  disabled,
  title,
  ...rest
}: RoleButtonProps) {
  const { can } = useRole();
  const allowed = can(need);
  return (
    <Button
      {...rest}
      disabled={disabled || !allowed}
      title={!allowed ? deniedHint : title}
    />
  );
}
