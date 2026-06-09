/** Neutral avatar / caret fill used when no valid server colour is available
 *  yet (pre-INIT) or when an untrusted colour fails validation. Mirrors the
 *  editorial `--ink-faint` token (collab surfaces use inline colours, not
 *  classes, because the value is per-session/per-peer). */
export const NEUTRAL_COLLAB_COLOR = "#8a8a8a";

/** Hex literal only: #rgb / #rgba / #rrggbb / #rrggbbaa. The server issues
 *  cursor colours from a fixed hex palette, so legitimate values always pass. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Sanitise a cursor/avatar colour that originates from an UNTRUSTED source — the
 * server's INIT frame or a peer's awareness state — before it is interpolated
 * into an inline `style` string/attribute. `setAttribute("style", ...)` bypasses
 * React's escaping, so an unvalidated value like `red; background: url(...)`
 * would inject arbitrary CSS. Only a hex literal is accepted; anything else
 * falls back to the neutral token. Never throws.
 */
export function safeCollabColor(
  color: string | null | undefined,
  fallback: string = NEUTRAL_COLLAB_COLOR,
): string {
  return typeof color === "string" && HEX_COLOR.test(color) ? color : fallback;
}
