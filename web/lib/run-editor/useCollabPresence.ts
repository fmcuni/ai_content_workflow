import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";

import { safeCollabColor } from "./collab-color";

export interface PresenceUser {
  clientId: number;
  name: string;
  email: string;
  color: string;
  /** True for the local session (awareness.clientID === clientId). */
  isSelf: boolean;
}

/** Awareness state.user shape published by useCollabDoc. Colour is server-issued
 *  and may be null until the INIT frame lands — we fall back to a neutral token. */
interface AwarenessUser {
  name: string;
  email: string;
  color: string | null;
}

/** Narrow an unknown awareness state to an AwarenessUser, or null if it lacks a
 *  usable (non-blank) name. Never throws — defends the render boundary. */
function readUser(state: unknown): AwarenessUser | null {
  if (typeof state !== "object" || state === null) return null;
  const user = (state as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;
  const { name, email, color } = user as {
    name?: unknown;
    email?: unknown;
    color?: unknown;
  };
  if (typeof name !== "string" || name.trim().length === 0) return null;
  return {
    name,
    email: typeof email === "string" ? email : "",
    color: typeof color === "string" ? color : null,
  };
}

/** Derive a stable, sorted PresenceUser list from the current awareness states.
 *  Called during render (see the hook), so it must never throw — a destroyed or
 *  malformed awareness yields an empty list rather than crashing the editor. */
function computePresence(awareness: Awareness): PresenceUser[] {
  const selfId = awareness.clientID;
  const users: PresenceUser[] = [];
  let states: Map<number, unknown>;
  try {
    states = awareness.getStates() as Map<number, unknown>;
  } catch {
    return [];
  }
  states.forEach((state: unknown, clientId: number) => {
    const user = readUser(state);
    if (!user) return;
    users.push({
      clientId,
      name: user.name,
      email: user.email,
      // Peer-supplied colour is untrusted — sanitise (falls back to neutral).
      color: safeCollabColor(user.color),
      isSelf: clientId === selfId,
    });
  });
  // Deterministic order: self first, then by name, then by clientId as a
  // tiebreaker so render order is stable across awareness changes.
  return users.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.clientId - b.clientId;
  });
}

/** Live list of editors present in the shared doc, derived from awareness.
 *  Returns [] when awareness is null (collab off). Subscribes to the awareness
 *  "change" event and cleans up on unmount / awareness change. */
export function useCollabPresence(awareness: Awareness | null): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>(() =>
    awareness ? computePresence(awareness) : [],
  );

  // Reset the derived list during render when the awareness instance changes
  // (React's "adjust state on prop change" pattern — mirrors useCollabDoc). This
  // keeps the effect a pure subscription, with no setState in its body, so the
  // first render after an awareness swap already reflects the new instance.
  const [tracked, setTracked] = useState<Awareness | null>(awareness);
  if (tracked !== awareness) {
    setTracked(awareness);
    setUsers(awareness ? computePresence(awareness) : []);
  }

  useEffect(() => {
    if (!awareness) return;
    const handler = (): void => {
      setUsers(computePresence(awareness));
    };
    awareness.on("change", handler);
    return () => {
      try {
        awareness.off("change", handler);
      } catch {
        // never throw from cleanup
      }
    };
  }, [awareness]);

  return users;
}
