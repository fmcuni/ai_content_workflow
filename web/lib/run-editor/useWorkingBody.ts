import { useCallback, useEffect, useRef } from "react";
import type { Doc as YDoc } from "yjs";

import { replaceCollabDoc } from "@/lib/run-editor/collab-html";

export interface UseWorkingBodyOptions {
  /** True when realtime collab is live (flag on + ydoc + provider bound). */
  collabActive: boolean;
  /**
   * True only once the shared doc has SYNCED with the server (collab status
   * `"connected"`). A whole-doc replace issued BEFORE sync computes its delta
   * against a not-yet-synced (empty/stale) local fragment; when the server's sync
   * step-2 then lands, Yjs UNIONS the old body back in (CRDT merge), silently
   * corrupting or reverting the write — the "restore does nothing" bug. So while
   * collab is active but not yet connected, the replace is DEFERRED (latest-wins)
   * and flushed once the doc connects. Mirrors the seed flow's `status` gate.
   */
  collabReady: boolean;
  /** The shared Yjs doc, or null when collab is off / not yet bound. */
  ydoc: YDoc | null;
  /** Current working body HTML (React state). */
  html: string;
  /** React setter for the working body. */
  setHtml: (updater: (html: string) => string) => void;
}

/** Options for a single working-body write. */
export interface ApplyWorkingOptions {
  /**
   * Force the CRDT replace even when the resolved body equals the (effect-synced,
   * possibly stale) `html` ref. Used by snapshot RESTORE / hydration: the React
   * `html` mirror can lag the live Yjs doc (it is only fed by the editor's
   * onUpdate, which is silent while the editor is unmounted in Review mode), so
   * the `next !== prev` short-circuit can wrongly skip the write. Restore is an
   * explicit, infrequent action, so a redundant whole-doc replace is acceptable.
   */
  force?: boolean;
}

export type ApplyWorking = (updater: (prev: string) => string, opts?: ApplyWorkingOptions) => void;

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
  collabReady,
  ydoc,
  html,
  setHtml,
}: UseWorkingBodyOptions): ApplyWorking {
  // Latest html, so applyWorking computes `next` from current content without a
  // stale closure (callers fire it from event handlers / mutation callbacks,
  // always after commit — so an effect-synced ref is current by the time it runs;
  // assigning the ref during render would trip react-hooks/refs).
  const currentHtmlRef = useRef(html);
  useEffect(() => {
    currentHtmlRef.current = html;
  }, [html]);

  // Single-slot "latest-wins" queue for a replace issued before the doc has
  // synced. Holds the most recent body to push; flushed by the effect below once
  // collab connects. null means nothing pending.
  const pendingReplaceRef = useRef<string | null>(null);

  // Flush a deferred replace once the doc connects. Without this gate a restore /
  // on-load hydration that fires during the sync round-trip would merge the old
  // body back in when sync step-2 arrives (see UseWorkingBodyOptions.collabReady).
  useEffect(() => {
    if (!collabActive || !collabReady || !ydoc) return;
    const pending = pendingReplaceRef.current;
    if (pending === null) return;
    pendingReplaceRef.current = null;
    replaceCollabDoc(ydoc, pending);
  }, [collabActive, collabReady, ydoc]);

  return useCallback(
    (updater: (prev: string) => string, opts?: ApplyWorkingOptions) => {
      // Collab off → pass the updater straight through (identical to today).
      if (!collabActive || !ydoc) {
        setHtml(updater);
        return;
      }

      const prev = currentHtmlRef.current;
      const next = updater(prev);
      // Dual-write: always update React state.
      setHtml(() => next);

      // Only mutate the CRDT when the body would actually change — a cheap string
      // compare that skips spurious whole-doc deltas on no-op writes (e.g.
      // "accept", where the working body is unchanged). `force` overrides it for
      // restore/hydration, where `prev` (the effect-synced ref) can be stale.
      if (!opts?.force && next === prev) return;

      // Defer until the doc has synced — replacing now would diff against an
      // unsynced fragment and merge the old body back in (CRDT union) once sync
      // step-2 lands. Queue the latest; the effect flushes it on connect.
      if (!collabReady) {
        pendingReplaceRef.current = next;
        return;
      }

      replaceCollabDoc(ydoc, next);
    },
    [collabActive, collabReady, ydoc, setHtml],
  );
}
