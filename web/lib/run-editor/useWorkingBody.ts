import { useCallback, useEffect, useRef } from "react";
import type { Doc as YDoc } from "yjs";

import { replaceCollabDoc } from "@/lib/run-editor/collab-html";

export interface UseWorkingBodyOptions {
  /** True when realtime collab is live (flag on + ydoc + provider bound). */
  collabActive: boolean;
  /** The shared Yjs doc, or null when collab is off / not yet bound. */
  ydoc: YDoc | null;
  /** Current working body HTML (React state). */
  html: string;
  /** React setter for the working body. */
  setHtml: (updater: (html: string) => string) => void;
}

/**
 * Collab-aware writer for EXTERNAL working-body writes (reject a tracked change,
 * AI apply-edits result, comment/review-anchor strip, snapshot restore).
 *
 * The live TipTap editor binds to the Yjs CRDT and IGNORES its `value` prop when
 * collab is on, so a plain `setHtml(...)` never reaches the shared doc: switching
 * panels shows stale content and the next keystroke re-propagates the old body,
 * losing the change. `applyWorking` dual-writes — always updates React `html`
 * (the Review-changes diff reads it, and during Review the live editor is
 * unmounted so no `onUpdate` fires) and, when collab is active, pushes the same
 * HTML into the shared Yjs doc.
 *
 * When collab is OFF this is byte-identical to today: it just calls `setHtml`
 * with the updater.
 *
 * Do NOT call `applyWorking` from the editor's own `onUpdate`/`onChange` path —
 * `replaceCollabDoc` emits an update that the live editor already handles, so
 * routing it back through here would loop.
 */
export function useWorkingBody({
  collabActive,
  ydoc,
  html,
  setHtml,
}: UseWorkingBodyOptions): (updater: (prev: string) => string) => void {
  // Latest html, so applyWorking computes `next` from current content without a
  // stale closure (callers fire it from event handlers / mutation callbacks,
  // always after commit — so an effect-synced ref is current by the time it runs;
  // assigning the ref during render would trip react-hooks/refs).
  const currentHtmlRef = useRef(html);
  useEffect(() => {
    currentHtmlRef.current = html;
  }, [html]);

  return useCallback(
    (updater: (prev: string) => string) => {
      // Collab off → pass the updater straight through (identical to today).
      if (!collabActive || !ydoc) {
        setHtml(updater);
        return;
      }

      const prev = currentHtmlRef.current;
      const next = updater(prev);
      // Dual-write: always update React state.
      setHtml(() => next);
      // Only mutate the CRDT when the body would actually change. Compare against
      // the current React html (which mirrors the Yjs doc in collab) — a cheap
      // string compare that skips spurious whole-doc deltas on no-op writes (e.g.
      // "accept", where the working body is unchanged) without serializing the
      // doc, and avoids serialization-mismatch false replaces.
      if (next !== prev) {
        replaceCollabDoc(ydoc, next);
      }
    },
    [collabActive, ydoc, setHtml],
  );
}
