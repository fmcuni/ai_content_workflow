"use client";
import { useCallback, useEffect, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
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
} from "lucide-react";

import { cn } from "@/lib/utils";
import { CommentAnchor } from "@/components/tiptap/CommentAnchor";

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

function Toolbar({ editor }: { editor: Editor }) {
  const promptLink = () => {
    const prev = (editor.getAttributes("link").href as string | undefined) ?? "";
    const url = window.prompt("Link URL (leave blank to remove)", prev || "https://");
    if (url === null) return;
    const trimmed = url.trim();
    if (trimmed === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
  };

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-t border border-b-0 border-rule bg-paper px-1.5 py-1">
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
      <ToolbarButton label="Link" active={editor.isActive("link")} onClick={promptLink}>
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

interface TipTapEditorProps {
  value: string;
  onChange: (html: string) => void;
  onAddComment?: (id: string, anchorText: string) => void;
  onCommentClick?: (id: string) => void;
}

export function TipTapEditor({
  value,
  onChange,
  onAddComment,
  onCommentClick,
}: TipTapEditorProps) {
  const [selectionPill, setSelectionPill] = useState<{ x: number; y: number } | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      LinkExtension.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { class: "text-accent underline underline-offset-2" },
      }),
      CommentAnchor,
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      if (from === to || !onAddComment) {
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
      },
      handleClickOn: (_view, _pos, _node, _nodePos, event) => {
        const target = event.target as HTMLElement;
        const span = target.closest("[data-comment-id]");
        if (span && onCommentClick) {
          onCommentClick(span.getAttribute("data-comment-id")!);
          return true;
        }
        return false;
      },
    },
    immediatelyRender: false,
  });

  // TipTap's `content` prop is only consumed on init. When `value` changes
  // externally (e.g. after the render query resolves), sync it in here —
  // otherwise the editor stays empty until it is unmounted and remounted.
  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  const addComment = useCallback(() => {
    if (!editor || !onAddComment) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const anchorText = editor.state.doc.textBetween(from, to, " ").slice(0, 120);
    const id = `c-${
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10)
    }`;
    editor.chain().focus().setCommentAnchor({ commentId: id }).run();
    onAddComment(id, anchorText);
    setSelectionPill(null);
  }, [editor, onAddComment]);

  if (!editor) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint animate-pulse">
        Loading editor…
      </p>
    );
  }

  return (
    <div className="relative">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      {selectionPill && onAddComment && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={addComment}
          style={{
            position: "fixed",
            left: selectionPill.x,
            top: selectionPill.y,
            zIndex: 50,
          }}
          className="inline-flex items-center gap-1.5 rounded border border-ink bg-paper px-2.5 py-1 text-[12px] font-mono uppercase tracking-wider text-ink shadow-md hover:bg-ink hover:text-paper"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" /> Comment
        </button>
      )}
    </div>
  );
}
