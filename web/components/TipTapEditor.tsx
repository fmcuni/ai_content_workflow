"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import Collaboration from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import type { Extensions } from "@tiptap/core";
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Strikethrough,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Link as LinkIcon,
  Undo2,
  Redo2,
  MessageSquarePlus,
  MessagesSquare,
  Table2,
  ChevronDown,
  Copy,
  Check,
  Pencil,
  Unlink,
  ExternalLink as ExternalLinkIcon,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { openExternal } from "@/lib/external-link";
import { CommentAnchor } from "@/components/tiptap/CommentAnchor";
import { ReviewAnchor } from "@/components/tiptap/ReviewAnchor";
import { FaqAccordion } from "@/components/tiptap/FaqAccordion";
import type { CollabProvider } from "@/lib/run-editor/useCollabDoc";
import { safeCollabColor } from "@/lib/run-editor/collab-color";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

type ToolbarButtonProps = {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
};

function ToolbarButton({ onClick, active, disabled, label, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded text-ink-soft transition-colors",
        "hover:bg-paper-deep hover:text-ink",
        "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-soft",
        active && "bg-ink text-paper hover:bg-ink hover:text-paper",
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-rule" />;
}

/**
 * CollaborationCaret render: a thin caret span coloured with the peer's
 * server-issued colour, carrying a small name label above it. Mirrors the
 * example in the extension's `.d.ts`; the two classes
 * (`.collaboration-carets__caret` / `__label`) are global and styled in
 * `app/globals.css` (component `.css` imports aren't allowed in the Next 16 app
 * router). The colour/name come from the awareness `user` state.
 */
function renderCollabCaret(user: { name?: string; color?: string }): HTMLElement {
  // Validate the colour before it lands in an inline `style` attribute —
  // setAttribute bypasses React escaping, so an untrusted peer/server colour
  // could otherwise inject arbitrary CSS.
  const color = safeCollabColor(user.color);
  const name = user.name ?? "Anonymous";
  const caret = document.createElement("span");
  caret.classList.add("collaboration-carets__caret");
  caret.setAttribute("style", `border-color: ${color}`);

  const label = document.createElement("div");
  label.classList.add("collaboration-carets__label");
  label.setAttribute("style", `background-color: ${color}`);
  label.insertBefore(document.createTextNode(name), null);

  caret.insertBefore(label, null);
  return caret;
}

/** Short anchor id with a domain prefix (`c-` AI comment, `r-` review note). */
function genAnchorId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}${rand}`;
}

function TableMenu({ editor }: { editor: Editor }) {
  const inTable = editor.isActive("table");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title="Table"
            aria-label="Table"
            aria-pressed={inTable}
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
              "inline-flex h-8 items-center gap-0.5 rounded px-1.5 text-ink-soft transition-colors",
              "hover:bg-paper-deep hover:text-ink",
              inTable && "bg-ink text-paper hover:bg-ink hover:text-paper",
            )}
          >
            <Table2 className="h-4 w-4" />
            <ChevronDown className="h-3 w-3" />
          </button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run()
          }
        >
          Insert table (3×3)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!inTable}
          onClick={() => editor.chain().focus().addRowBefore().run()}
        >
          Add row above
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          onClick={() => editor.chain().focus().addRowAfter().run()}
        >
          Add row below
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          onClick={() => editor.chain().focus().addColumnBefore().run()}
        >
          Add column left
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          onClick={() => editor.chain().focus().addColumnAfter().run()}
        >
          Add column right
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!inTable}
          onClick={() => editor.chain().focus().toggleHeaderRow().run()}
        >
          Toggle header row
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          onClick={() => editor.chain().focus().mergeOrSplit().run()}
        >
          Merge / split cell
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!inTable}
          onClick={() => editor.chain().focus().deleteRow().run()}
        >
          Delete row
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          onClick={() => editor.chain().focus().deleteColumn().run()}
        >
          Delete column
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!inTable}
          variant="destructive"
          onClick={() => editor.chain().focus().deleteTable().run()}
        >
          Delete table
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Toolbar({ editor, onLinkClick }: { editor: Editor; onLinkClick: () => void }) {
  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center gap-0.5 rounded-t border border-b-0 border-rule bg-paper px-1.5 py-1">
      <ToolbarButton label="Bold (⌘B)" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
        <BoldIcon className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton label="Italic (⌘I)" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <ItalicIcon className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton label="Strikethrough" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="h-4 w-4" />
      </ToolbarButton>
      <Divider />
      <ToolbarButton label="Heading 2" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton label="Heading 3" active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 className="h-4 w-4" />
      </ToolbarButton>
      <Divider />
      <ToolbarButton label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton label="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton label="Blockquote" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote className="h-4 w-4" />
      </ToolbarButton>
      <Divider />
      <TableMenu editor={editor} />
      <Divider />
      <ToolbarButton label="Link" active={editor.isActive("link")} onClick={onLinkClick}>
        <LinkIcon className="h-4 w-4" />
      </ToolbarButton>
      <Divider />
      <ToolbarButton label="Undo (⌘Z)" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
        <Undo2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton label="Redo (⇧⌘Z)" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
        <Redo2 className="h-4 w-4" />
      </ToolbarButton>
    </div>
  );
}

interface LinkPanelState {
  x: number;
  y: number;
  href: string;
  editing: boolean;
}

interface LinkPanelProps {
  state: LinkPanelState;
  onSave: (url: string) => void;
  onStartEdit: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/**
 * Floating link panel — replaces the old `window.prompt`. In read mode it shows
 * the full URL with one-click copy, open, edit, and remove. In edit mode it
 * swaps in an inline input so the operator can change the URL without a browser
 * dialog. Mouse-down is suppressed on the buttons so the editor selection (which
 * `setLink` / `unsetLink` act on) survives the click.
 */
function LinkPanel({ state, onSave, onStartEdit, onRemove, onClose }: LinkPanelProps) {
  // Uncontrolled input (read via ref) so re-seeding on edit needs no effect /
  // cascading render; `key` on the input remounts it with a fresh defaultValue
  // when the panel switches to a different link.
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.href);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be unavailable (insecure context); ignore silently.
    }
  };

  const iconBtn =
    "inline-flex h-7 w-7 items-center justify-center rounded text-ink-soft hover:bg-paper-deep hover:text-ink";

  return (
    <div
      style={{ position: "fixed", left: state.x, top: state.y, zIndex: 50 }}
      className="flex items-center gap-1 rounded border border-ink bg-paper px-2 py-1.5 shadow-md max-w-[420px]"
    >
      {state.editing ? (
        <>
          <input
            key={state.href}
            ref={inputRef}
            autoFocus
            defaultValue={state.href || "https://"}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSave(inputRef.current?.value ?? "");
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="https://example.com"
            className="w-[260px] border-b border-rule bg-transparent px-1 py-0.5 text-[13px] text-ink focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSave(inputRef.current?.value ?? "")}
            className={iconBtn}
            title="Save link"
            aria-label="Save link"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
            className={iconBtn}
            title="Cancel"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      ) : (
        <>
          <a
            href={state.href}
            onClick={(e) => {
              e.preventDefault();
              void openExternal(state.href);
            }}
            title={state.href}
            className="max-w-[220px] truncate text-[13px] text-accent underline underline-offset-2"
          >
            {state.href}
          </a>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-rule" />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={copy}
            className={iconBtn}
            title={copied ? "Copied" : "Copy URL"}
            aria-label="Copy URL"
          >
            {copied ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void openExternal(state.href)}
            className={iconBtn}
            title="Open in new tab"
            aria-label="Open link"
          >
            <ExternalLinkIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onStartEdit}
            className={iconBtn}
            title="Edit URL"
            aria-label="Edit link"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRemove}
            className={iconBtn}
            title="Remove link"
            aria-label="Remove link"
          >
            <Unlink className="h-4 w-4" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
            className={iconBtn}
            title="Close"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}

/** Live-collaboration binding: a shared Yjs doc + the provider's awareness +
 *  this session's display identity. Present only when realtime collab is on. */
interface TipTapCollab {
  ydoc: import("yjs").Doc;
  provider: CollabProvider; // has `.awareness` for CollaborationCaret
  user: { name: string; color: string };
}

interface TipTapEditorProps {
  value: string;
  onChange: (html: string) => void;
  /** AI-edit instruction anchor (existing pipeline — `data-comment-id`). */
  onAddComment?: (id: string, anchorText: string) => void;
  onCommentClick?: (id: string) => void;
  /** Human review-thread anchor (separate pipeline — `data-review-id`). */
  onAddReviewNote?: (id: string, anchorText: string) => void;
  onReviewClick?: (id: string) => void;
  /** When set, the editor binds its body to this shared Yjs doc for realtime
   *  collaboration (Collaboration + CollaborationCaret). When undefined/null the
   *  editor is the standalone string-backed editor (default; byte-identical to
   *  before). */
  collab?: TipTapCollab | null;
}

export function TipTapEditor({
  value,
  onChange,
  onAddComment,
  onCommentClick,
  onAddReviewNote,
  onReviewClick,
  collab,
}: TipTapEditorProps) {
  const collabActive = !!collab;
  const [selectionPill, setSelectionPill] = useState<{ x: number; y: number } | null>(null);
  const [linkPanel, setLinkPanel] = useState<LinkPanelState | null>(null);
  // Read by the editor's selection/click callbacks (registered once) so they see
  // the live "is the panel mid-edit?" flag without re-creating the editor.
  const linkEditingRef = useRef(false);
  useEffect(() => {
    linkEditingRef.current = linkPanel?.editing ?? false;
  }, [linkPanel]);

  const editor = useEditor({
    extensions: [
      // StarterKit v3 bundles its own Link extension; disable it so our
      // explicitly-configured LinkExtension below is the sole registration.
      // (Two registrations triggered TipTap's "Duplicate extension names:
      // ['link']" console warning.) In collab mode also disable StarterKit's
      // history — Yjs (Collaboration) supplies undo/redo, and a second history
      // plugin fights the CRDT (mirrors collab-roundtrip.test.tsx).
      StarterKit.configure(collab ? { link: false, undoRedo: false } : { link: false }),
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
      // Realtime collaboration: bind the body to the shared Yjs doc and render
      // remote carets from the provider's awareness. Appended only when a
      // `collab` binding is supplied — otherwise the array is byte-identical to
      // the standalone editor above.
      ...(collab
        ? ([
            Collaboration.configure({ document: collab.ydoc }),
            CollaborationCaret.configure({
              // The caret extension types `provider` as `any`; our binding is
              // typed via CollabProvider so this single localized cast is the
              // only `any` at the boundary.
              provider: collab.provider as unknown,
              user: collab.user,
              render: renderCollabCaret,
            }),
          ] as Extensions)
        : []),
    ],
    // Yjs is the source of truth in collab mode; passing `content` alongside
    // Collaboration would duplicate the doc, so seed nothing here.
    content: collab ? undefined : value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    onSelectionUpdate: ({ editor }) => {
      // Dismiss the link panel once the cursor leaves the link — unless we're
      // mid-edit in the panel's input (which blurs the editor selection).
      // setState(null) is a no-op re-render when already null (React bails).
      if (!linkEditingRef.current && !editor.isActive("link")) {
        setLinkPanel(null);
      }
      const { from, to } = editor.state.selection;
      if (from === to || (!onAddComment && !onAddReviewNote)) {
        setSelectionPill(null);
        return;
      }
      const coords = editor.view.coordsAtPos(to);
      setSelectionPill({ x: coords.left, y: coords.top + 22 });
    },
    editorProps: {
      attributes: {
        class:
          "editorial-prose max-w-none min-h-[480px] focus:outline-none px-6 py-5 border border-rule rounded-b bg-paper",
        // Opt out of WebKit/macOS text substitutions inside the editor: the
        // "double-space → full stop" shortcut and auto-capitalisation inject
        // half-width ". " / capitals that are wrong for Chinese prose.
        autocorrect: "off",
        autocapitalize: "off",
      },
      handleClickOn: (_view, _pos, _node, _nodePos, event) => {
        const target = event.target as HTMLElement;
        // A link click opens the URL panel (full URL + copy/open/edit/remove)
        // instead of navigating — openOnClick is disabled on the extension.
        const anchor = target.closest("a") as HTMLAnchorElement | null;
        if (anchor) {
          const href = anchor.getAttribute("href") ?? "";
          setLinkPanel({ x: event.clientX, y: event.clientY + 14, href, editing: false });
          return true;
        }
        const span = target.closest("[data-comment-id]");
        if (span && onCommentClick) {
          onCommentClick(span.getAttribute("data-comment-id")!);
          return true;
        }
        const reviewSpan = target.closest("[data-review-id]");
        if (reviewSpan && onReviewClick) {
          onReviewClick(reviewSpan.getAttribute("data-review-id")!);
          return true;
        }
        return false;
      },
    },
    immediatelyRender: false,
  // Recreate the editor only when collab presence flips. Collab presence is
  // stable per mount (driven by a feature flag), so this never thrashes — and
  // it avoids a stale closure over `collab`/`collabActive` in the callbacks.
  }, [collabActive]);

  // TipTap's `content` prop is only consumed on init. When `value` changes
  // externally (e.g. after the render query resolves), sync it in here —
  // otherwise the editor stays empty until it is unmounted and remounted.
  useEffect(() => {
    if (!editor) return;
    // In collab mode the Yjs doc is the source of truth — never setContent, it
    // fights the CRDT (and would clobber concurrent peers' edits).
    if (collabActive) return;
    // Never re-set content mid-IME-composition: CJK input (pinyin/cangjie/zhuyin)
    // stays "open" across several keystrokes, and setContent during that window
    // wipes the in-progress characters. Western typing commits per keystroke so
    // it rarely hits this; Chinese editing hits it constantly.
    if (editor.view.composing) return;
    if (editor.getHTML() === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value, collabActive]);

  const addComment = useCallback(() => {
    if (!editor || !onAddComment) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const anchorText = editor.state.doc.textBetween(from, to, " ").slice(0, 120);
    const id = genAnchorId("c-");
    editor.chain().focus().setCommentAnchor({ commentId: id }).run();
    onAddComment(id, anchorText);
    setSelectionPill(null);
  }, [editor, onAddComment]);

  // Human review note — a SEPARATE pipeline from the AI comment above. Wraps the
  // selection in a `reviewAnchor` mark and opens a discussion thread.
  const addReviewNote = useCallback(() => {
    if (!editor || !onAddReviewNote) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const anchorText = editor.state.doc.textBetween(from, to, " ").slice(0, 120);
    const id = genAnchorId("r-");
    editor.chain().focus().setReviewAnchor({ reviewId: id }).run();
    onAddReviewNote(id, anchorText);
    setSelectionPill(null);
  }, [editor, onAddReviewNote]);

  // Toolbar link button: open the panel in read mode over an existing link, or
  // in edit mode to create one on the current selection.
  const openLinkPanel = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const onLink = editor.isActive("link");
    if (!onLink && from === to) return; // nothing to link, nothing to inspect
    const coords = editor.view.coordsAtPos(to);
    const href = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkPanel({ x: coords.left, y: coords.bottom + 6, href, editing: !onLink });
  }, [editor]);

  const saveLink = useCallback(
    (url: string) => {
      if (!editor) return;
      const trimmed = url.trim();
      if (trimmed === "") {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
        setLinkPanel(null);
        return;
      }
      editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
      setLinkPanel((p) => (p ? { ...p, href: trimmed, editing: false } : p));
    },
    [editor],
  );

  const removeLink = useCallback(() => {
    if (!editor) return;
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkPanel(null);
  }, [editor]);

  if (!editor) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint animate-pulse">
        Loading editor…
      </p>
    );
  }

  return (
    <div className="relative">
      <Toolbar editor={editor} onLinkClick={openLinkPanel} />
      <EditorContent editor={editor} />
      {linkPanel && (
        <LinkPanel
          state={linkPanel}
          onSave={saveLink}
          onStartEdit={() => setLinkPanel((p) => (p ? { ...p, editing: true } : p))}
          onRemove={removeLink}
          onClose={() => setLinkPanel(null)}
        />
      )}
      {selectionPill && (onAddComment || onAddReviewNote) && (
        <div
          style={{
            position: "fixed",
            left: selectionPill.x,
            top: selectionPill.y,
            zIndex: 50,
          }}
          className="inline-flex items-center gap-1 rounded border border-ink bg-paper px-1 py-1 shadow-md"
        >
          {onAddComment && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={addComment}
              title="Ask AI to edit this passage"
              className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] font-mono uppercase tracking-wider text-ink hover:bg-ink hover:text-paper"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" /> AI edit
            </button>
          )}
          {onAddComment && onAddReviewNote && <Divider />}
          {onAddReviewNote && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={addReviewNote}
              title="Start a human review thread on this passage"
              className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] font-mono uppercase tracking-wider text-ink hover:bg-ink hover:text-paper"
            >
              <MessagesSquare className="h-3.5 w-3.5" /> Review
            </button>
          )}
        </div>
      )}
    </div>
  );
}
