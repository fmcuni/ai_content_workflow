import { useEffect, useRef, useState } from "react";
import type { Doc as YDoc } from "yjs";

import { seedCollabDocIfEmpty } from "@/lib/run-editor/collab-html";
import type { CollabStatus } from "@/lib/run-editor/useCollabDoc";

/**
 * Seed a fresh run's shared Yjs doc from the generated draft HTML exactly once,
 * on first connect.
 *
 * Seeding is deferred until {@link useCollabDoc} reports `status === "connected"`
 * — i.e. AFTER the provider has synced with the RunDoc Durable Object (sync step
 * 2 + the server INIT frame). Only then do we know the TRUE persisted doc state,
 * so a returning run whose doc already has persisted content is never re-seeded
 * (the emptiness check in `seedCollabDocIfEmpty` then sees real content). A
 * per-`ydoc` guard ensures we attempt the seed at most once per doc instance.
 *
 * RACE BOUNDARY (closed in Phase 5):
 * The emptiness guard is client-side and is fully safe for the common
 * single-opener case AND for any returning run (a persisted doc is non-empty →
 * no re-seed). The previously-documented residual — two BRAND-NEW first-joiners
 * opening the same empty run within the sync round-trip, both observing an empty
 * doc and seeding (duplicating content on merge) — is now closed by the RunDoc
 * DO's authoritative "you-are-the-seeder" grant: the DO designates exactly ONE
 * connection as primary, surfaced as `isSeedAuthority` on the useCollabDoc
 * handle. Seeding requires BOTH that grant AND the local emptiness check, so a
 * non-authoritative joiner never seeds even if it momentarily sees an empty doc.
 */

export interface UseSeedCollabDocArgs {
  /** The shared Yjs doc from useCollabDoc (null when collab is disabled). */
  ydoc: YDoc | null;
  /** The collab connection status from useCollabDoc. */
  status: CollabStatus;
  /** The generated draft HTML to seed an empty doc from (the run's render body). */
  draftHtml: string;
  /** Master gate — collab active AND the draft is ready. Seeding never runs when false. */
  enabled: boolean;
  /** The DO-issued seeder grant from useCollabDoc. Only the authoritative
   *  first-writer seeds — closes the two-first-joiners race. */
  isSeedAuthority: boolean;
}

export interface SeedCollabDocResult {
  /** True once this client has seeded the doc this mount (false if it found the doc non-empty). */
  seeded: boolean;
}

export function useSeedCollabDoc(args: UseSeedCollabDocArgs): SeedCollabDocResult {
  const { ydoc, status, draftHtml, enabled, isSeedAuthority } = args;

  const [seeded, setSeeded] = useState<boolean>(false);

  // Guard: at most one seed ATTEMPT per ydoc instance. Tracking the last-seen
  // doc lets us RESET the attempt flag when a new run/connection swaps the doc.
  const lastYdocRef = useRef<YDoc | null>(null);
  const attemptedRef = useRef<boolean>(false);

  useEffect(() => {
    // New doc identity (new run / new connection) → reset the per-doc guard so
    // the fresh doc can seed. Mirrors the "adjust state/ref on key change" pattern.
    if (ydoc !== lastYdocRef.current) {
      lastYdocRef.current = ydoc;
      attemptedRef.current = false;
      // Reset the result when the doc identity changes so a new run does not
      // report the previous doc's seed outcome.
      setSeeded(false);
    }

    if (attemptedRef.current) return;
    const canSeed =
      enabled &&
      isSeedAuthority &&
      ydoc !== null &&
      status === "connected" &&
      draftHtml.trim() !== "";
    if (!canSeed) return;

    attemptedRef.current = true;
    let didSeed = false;
    try {
      // Writes into the shared doc; useCollabDoc's update handler relays it to
      // the DO — we send nothing ourselves. seedCollabDocIfEmpty is already safe,
      // but guard defensively so the hook never throws.
      didSeed = seedCollabDocIfEmpty(ydoc, draftHtml);
    } catch {
      didSeed = false;
    }
    // Intentional setState in effect: seeding is a one-shot side effect that
    // must publish its outcome to consumers (mirrors useCollabDoc's status pattern).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeeded(didSeed);
  }, [enabled, isSeedAuthority, ydoc, status, draftHtml]);

  return { seeded };
}
