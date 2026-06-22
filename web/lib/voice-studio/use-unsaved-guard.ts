"use client";

import { useEffect } from "react";

/** Confirm copy shown when leaving with unsaved drafts. */
function confirmMessage(count: number): string {
  const noun = count === 1 ? "unsaved change" : "unsaved changes";
  return `You have ${count} ${noun} in this voice. Leave and discard them?`;
}

/**
 * Guard against losing in-memory Studio drafts. While `unsavedCount > 0` it:
 *   1. arms `beforeunload` so a tab reload / close prompts the browser dialog;
 *   2. intercepts in-app navigation by capturing left-clicks on same-origin
 *      anchors that point to a different path, and confirms before allowing it.
 *
 * The App Router has no first-party "block this navigation" hook, so the anchor
 * capture is the supported, framework-agnostic approach — it covers the only
 * in-Studio exits (the "← Voices" link, a voice switch). `window.confirm` keeps
 * it synchronous so the click can be cancelled in place.
 */
export function useUnsavedGuard(unsavedCount: number): void {
  useEffect(() => {
    if (unsavedCount <= 0) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy assignment kept for older engines; modern browsers show a generic
      // string regardless of the value.
      event.returnValue = "";
      return "";
    };

    const onClickCapture = (event: MouseEvent) => {
      // Only guard genuine user clicks; programmatic / synthetic clicks (e.g.
      // .click() calls, test harnesses) should pass through untouched.
      if (!event.isTrusted) return;
      // Only plain left-clicks navigate; let modified clicks (new tab) through.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as Element | null;
      const anchor = target?.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      let destination: URL;
      try {
        destination = new URL(href, window.location.href);
      } catch {
        return;
      }
      // Same path (e.g. an in-page anchor) is not a navigation away.
      if (
        destination.origin === window.location.origin &&
        destination.pathname === window.location.pathname
      ) {
        return;
      }
      if (!window.confirm(confirmMessage(unsavedCount))) {
        // Cancel the navigation only. Avoid stopPropagation() here: in the capture
        // phase it would also swallow the event from other legitimate capture-phase
        // listeners. preventDefault() is enough to stop the anchor navigating.
        event.preventDefault();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    // Capture phase so we run before Next's Link click handler navigates.
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [unsavedCount]);
}
