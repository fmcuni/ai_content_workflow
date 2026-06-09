import { Editor } from "@tiptap/core";
import type { Doc as YDoc } from "yjs";

import { buildEditorExtensions } from "@/components/tiptap/editor-extensions";

/**
 * Headless flatten/seed primitives for the realtime-collab run editor.
 *
 * Both build their schema through {@link buildEditorExtensions} — the single
 * source of truth shared with the live `TipTapEditor` — so a headless editor
 * can NEVER drift from the live one (the drift that flattened the FAQ widget on
 * 2026-06-09). Both are CLIENT-SIDE ONLY: a headless TipTap editor needs a DOM
 * (`document`), so call these only in the browser.
 */

/** Flatten the live collaborative Yjs doc to HTML using the SSOT schema. MUST be
 *  byte-identical to what the non-collab production editor produces for the same
 *  content (FAQ/table/link/anchor/CJK preserved). CLIENT-SIDE ONLY (needs a DOM). */
export function flattenCollabDoc(ydoc: YDoc): string {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildEditorExtensions({ collabDoc: ydoc }),
  });
  try {
    return editor.getHTML();
  } finally {
    editor.destroy();
  }
}

/** Seed an EMPTY shared doc from draft HTML, once. Returns true if it seeded,
 *  false if the doc already had content (idempotent no-op). Binding a headless
 *  editor to the shared doc and calling setContent writes through y-prosemirror
 *  into the shared Yjs doc (same mechanism as collab-roundtrip.test.tsx).
 *  CLIENT-SIDE ONLY. */
export function seedCollabDocIfEmpty(ydoc: YDoc, draftHtml: string): boolean {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildEditorExtensions({ collabDoc: ydoc }),
  });
  try {
    if (!editor.isEmpty) return false; // already has content — never re-seed
    if (!draftHtml || draftHtml.trim() === "") return false; // nothing to seed
    editor.commands.setContent(draftHtml, { emitUpdate: true });
    return true;
  } finally {
    editor.destroy();
  }
}

/** Replace the ENTIRE shared doc fragment with `html`. Used for external
 *  working-body writes (reject tracked change, AI apply-edits, comment/review
 *  strip, snapshot restore) that must propagate into the CRDT when collab is on
 *  — without it the live editor (bound to Yjs, ignoring its `value` prop) shows
 *  stale content and the next keystroke re-propagates the old body, losing the
 *  change. Binds a headless editor to the shared doc through the SSOT schema and
 *  setContent's the whole document (whole-fragment replace is intentional).
 *  CLIENT-SIDE ONLY (needs a DOM). */
export function replaceCollabDoc(ydoc: YDoc, html: string): void {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildEditorExtensions({ collabDoc: ydoc }),
  });
  try {
    editor.commands.setContent(html, { emitUpdate: true });
  } finally {
    editor.destroy();
  }
}
