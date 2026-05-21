"use client";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";

export function TipTapEditor({
  value, onChange,
}: { value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    extensions: [StarterKit, Link],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none min-h-[400px] focus:outline-none p-4 border rounded bg-white",
      },
    },
    immediatelyRender: false,
  });
  return <EditorContent editor={editor} />;
}
