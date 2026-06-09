"use client";

import { useEffect, useRef } from "react";

import { isSupabaseAuth } from "@/lib/supabase-client";

// 6-hour idle timeout. After this much inactivity (no pointer/key/visibility
// activity) the watchdog signs the user out and routes them to the login page
// with an `inactivity` reason so the UI can explain why.
//
// Spec: docs/superpowers/specs/2026-06-10-supabase-auth-migration.md ("Idle expiry")
export const IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

// Activity signals that reset the idle timer. `visibilitychange` catches the
// user returning to a backgrounded tab; pointer/key/scroll catch active use.
const ACTIVITY_EVENTS: readonly string[] = [
  "pointerdown",
  "pointermove",
  "keydown",
  "scroll",
  "visibilitychange",
];

export interface IdleWatchdogOptions {
  /** Called on idle expiry. Should sign the user out + route to /login. */
  onExpire: () => void;
  /** Override the timeout (tests). Defaults to IDLE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** When false, the watchdog does nothing (e.g. legacy auth path). */
  enabled?: boolean;
}

/**
 * Arms a single inactivity timer that resets on user activity and fires
 * `onExpire` once after `timeoutMs` of no activity. Throttles resets so a burst
 * of pointermove events does not reschedule the timer on every frame.
 *
 * Returns nothing; cleans up listeners + timer on unmount or when disabled.
 */
export function useIdleWatchdog({
  onExpire,
  timeoutMs = IDLE_TIMEOUT_MS,
  enabled = true,
}: IdleWatchdogOptions): void {
  // Keep the latest onExpire without re-arming the timer effect each render.
  // The ref is updated in an effect (not during render) per react-hooks/refs.
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastReset = Date.now();
    // Collapse rapid event bursts (e.g. pointermove) so we don't reschedule the
    // timer on every frame, while still honouring genuinely spaced activity.
    const RESET_THROTTLE_MS = 250;

    function arm(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => onExpireRef.current(), timeoutMs);
    }

    function onActivity(): void {
      // Ignore the visibility event when the tab is being hidden — only a
      // return-to-foreground (or genuine input) counts as activity.
      if (document.visibilityState === "hidden") {
        return;
      }
      const now = Date.now();
      if (now - lastReset < RESET_THROTTLE_MS) return;
      lastReset = now;
      arm();
    }

    arm();
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, onActivity, { passive: true });
    }

    return () => {
      if (timer) clearTimeout(timer);
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, onActivity);
      }
    };
  }, [enabled, timeoutMs]);
}

/** True when the idle watchdog should run (Supabase auth path only). */
export function idleWatchdogEnabled(): boolean {
  return isSupabaseAuth();
}
