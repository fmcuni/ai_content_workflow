/**
 * Open an external URL in a new browser tab.
 *
 * A no-op during SSR (no `window`). Used by callers that open a link
 * imperatively (e.g. the editor link panel) rather than via an anchor element.
 */
export function openExternal(url: string): void {
  if (!url || typeof window === "undefined") return;
  window.open(url, "_blank", "noopener,noreferrer");
}
