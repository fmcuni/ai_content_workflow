"use client";
import type { Awareness } from "y-protocols/awareness";

import { useCollabPresence, type PresenceUser } from "@/lib/run-editor/useCollabPresence";

interface CollabPresenceProps {
  awareness: Awareness | null;
  /** Optional cap on visible avatars before a "+N" overflow chip. Default 5. */
  max?: number;
}

const DEFAULT_MAX = 5;

/** First letters of the first two whitespace-separated words, uppercased.
 *  Falls back to the first character so single-word names still render. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function accessibleName(user: PresenceUser): string {
  return user.isSelf ? `${user.name} (you)` : user.name;
}

interface AvatarProps {
  user: PresenceUser;
  first: boolean;
}

function Avatar({ user, first }: AvatarProps) {
  const label = accessibleName(user);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ backgroundColor: user.color }}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full ring-1 ring-paper font-mono text-[10px] font-semibold uppercase tracking-tight text-white shadow-sm ${
        first ? "" : "-ml-1.5"
      }`}
    >
      {initials(user.name)}
    </span>
  );
}

/**
 * Non-interactive "who's connected" presence indicator: an overlapped avatar
 * stack derived from the shared doc's Yjs awareness, each avatar filled with the
 * user's server-issued cursor colour. Renders NOTHING when nobody is present
 * (collab off / empty list), so it is safe to drop into the shell before the
 * feature flag is flipped in Phase 5.
 */
export function CollabPresence({ awareness, max = DEFAULT_MAX }: CollabPresenceProps) {
  const users = useCollabPresence(awareness);
  if (users.length === 0) return null;

  const cap = Math.max(0, max);
  const visible = users.slice(0, cap);
  const overflow = users.length - visible.length;

  return (
    <span
      aria-label="Editors currently connected"
      className="inline-flex items-center"
    >
      {visible.map((user, index) => (
        <Avatar key={user.clientId} user={user} first={index === 0} />
      ))}
      {overflow > 0 && (
        <span
          aria-label={`${overflow} more`}
          title={`${overflow} more`}
          className="-ml-1.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-rule bg-paper px-1 font-mono text-[10px] font-semibold uppercase tracking-tight text-ink-faint ring-1 ring-paper"
        >
          {`+${overflow}`}
        </span>
      )}
    </span>
  );
}
