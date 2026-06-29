import type { KeyboardEvent } from "react";

/**
 * The one keyboard contract for annotation composers: ⌘↵ / Ctrl+↵ submits, Esc
 * cancels (when a cancel handler is given). Shared by the review reply box and
 * the pending-note composer so the two can't drift on keybindings.
 */
export function onComposerKeyDown(
  e: KeyboardEvent,
  submit: () => void,
  cancel?: () => void,
): void {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submit();
  } else if (cancel && e.key === "Escape") {
    e.preventDefault();
    cancel();
  }
}
