import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import Collaboration from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import type { Extensions } from "@tiptap/core";
import type { Doc as YDoc } from "yjs";

import { CommentAnchor } from "@/components/tiptap/CommentAnchor";
import { ReviewAnchor } from "@/components/tiptap/ReviewAnchor";
import { FaqAccordion } from "@/components/tiptap/FaqAccordion";

/**
 * Single source of truth (SSOT) for the run-editor's TipTap schema.
 *
 * The biggest fidelity risk in this codebase is the editor schema DRIFTING
 * between the live editor and any headless editor (flatten/seed) — that drift
 * is exactly how the Bowtie FAQ accordion widget got flattened to `<p>` and
 * published broken (regression 2026-06-09). Every editor — the live
 * `TipTapEditor`, the headless flatten/seed primitives, and the round-trip
 * tests — builds its extension list here so the schema has ONE source.
 */

/** CollaborationCaret binding — LIVE editor only (renders remote carets in the
 *  DOM). Headless flatten/seed omit it. */
export interface CollabCaretBinding {
  /** The y-websocket-compatible provider (typed `unknown` at the caret boundary). */
  provider: unknown;
  user: { name: string; color: string };
  render: (user: { name?: string; color?: string }) => HTMLElement;
}

export interface BuildEditorExtensionsOptions {
  /** Bind the body to this shared Yjs doc (adds Collaboration + drops StarterKit history). */
  collabDoc?: YDoc | null;
  /** Render remote carets — LIVE editor only. Omit for headless flatten/seed (no DOM caret needed). */
  caret?: CollabCaretBinding | null;
}

export function buildEditorExtensions(opts?: BuildEditorExtensionsOptions): Extensions {
  // StarterKit v3 bundles its own Link extension; disable it so our explicitly
  // configured LinkExtension below is the sole registration. (Two registrations
  // triggered TipTap's "Duplicate extension names: ['link']" console warning.)
  // In collab mode also disable StarterKit's history — Yjs (Collaboration)
  // supplies undo/redo, and a second history plugin fights the CRDT.
  const extensions: Extensions = [
    StarterKit.configure(opts?.collabDoc ? { link: false, undoRedo: false } : { link: false }),
    LinkExtension.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { class: "text-accent underline underline-offset-2" },
    }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    CommentAnchor,
    // Human review-thread highlight (separate from the AI CommentAnchor).
    ReviewAnchor,
    // Preserve the Bowtie FAQ accordion (div.editor__faq) — without this the
    // editor flattens the widget to bare <p> tags and publishes it that way.
    FaqAccordion,
  ];

  // Realtime collaboration: bind the body to the shared Yjs doc.
  if (opts?.collabDoc) {
    extensions.push(Collaboration.configure({ document: opts.collabDoc }));
  }

  // Render remote carets from the provider's awareness — LIVE editor only.
  if (opts?.caret) {
    extensions.push(
      CollaborationCaret.configure({
        // The caret extension types `provider` as `any`; our binding is typed
        // via CollabProvider so this single localized cast is the only `any` at
        // the boundary.
        provider: opts.caret.provider as unknown,
        user: opts.caret.user,
        render: opts.caret.render,
      }),
    );
  }

  return extensions;
}
