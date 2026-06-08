import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Trash2, Plus, HelpCircle } from "lucide-react";

import type { FaqItem } from "./faq-markup";

/**
 * In-editor view for the {@link FaqAccordion} node. The accordion markup is not
 * editable as free-form rich text (TipTap would strip the custom divs), so the
 * Q/A pairs are edited through dedicated fields here. Serialization is handled
 * by the node's `renderHTML`, NOT this view — so what publishes is always the
 * exact Bowtie FAQ widget regardless of how it looks in the editor.
 *
 * The wrapper is `contentEditable={false}` (atomic island); inputs stop key
 * propagation so editor shortcuts (Backspace, ⌘B, …) don't fire while typing.
 */
export function FaqNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const items = (node.attrs.items as FaqItem[] | undefined) ?? [];
  const editable = editor.isEditable;

  const commit = (next: FaqItem[]) => updateAttributes({ items: next });
  const setQuestion = (i: number, q: string) =>
    commit(items.map((it, j) => (j === i ? { ...it, q } : it)));
  const setAnswer = (i: number, a: string) =>
    commit(items.map((it, j) => (j === i ? { ...it, a } : it)));
  const remove = (i: number) => commit(items.filter((_, j) => j !== i));
  const add = () => commit([...items, { q: "", a: "" }]);

  const stopKeys = (e: React.KeyboardEvent) => e.stopPropagation();

  return (
    <NodeViewWrapper
      contentEditable={false}
      className="my-4 rounded border border-rule bg-paper-deep/40"
    >
      <div className="flex items-center gap-1.5 border-b border-rule px-3 py-1.5">
        <HelpCircle className="h-3.5 w-3.5 text-ink-soft" />
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">
          常見問題 · FAQ widget
        </span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-faint">
          {items.length}
        </span>
      </div>

      <div className="space-y-3 p-3">
        {items.map((item, i) => (
          <div key={i} className="rounded border border-rule bg-paper p-2.5">
            <div className="mb-1.5 flex items-start gap-2">
              <input
                value={item.q}
                disabled={!editable}
                onChange={(e) => setQuestion(i, e.target.value)}
                onKeyDown={stopKeys}
                placeholder="問題 / Question"
                className="flex-1 border-b border-rule bg-transparent px-1 py-0.5 text-[14px] font-medium text-ink focus:border-accent focus:outline-none disabled:opacity-60"
              />
              {editable && (
                <button
                  type="button"
                  title="Remove question"
                  aria-label="Remove question"
                  onClick={() => remove(i)}
                  className="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-paper-deep hover:text-accent-deep"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <textarea
              value={item.a}
              disabled={!editable}
              onChange={(e) => setAnswer(i, e.target.value)}
              onKeyDown={stopKeys}
              rows={3}
              placeholder="答案 / Answer"
              className="w-full resize-y border border-rule bg-transparent px-2 py-1 text-[13px] leading-relaxed text-ink focus:border-accent focus:outline-none disabled:opacity-60"
            />
          </div>
        ))}

        {editable && (
          <button
            type="button"
            onClick={add}
            className="inline-flex items-center gap-1.5 rounded border border-dashed border-rule px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:border-ink hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" /> Add question
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}
