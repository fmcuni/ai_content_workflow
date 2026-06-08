import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { FaqNodeView } from "./FaqNodeView";
import { faqItemsToDomSpec, parseFaqElement, type FaqItem } from "./faq-markup";

/**
 * TipTap node for the Bowtie FAQ accordion (`div.editor__faq`).
 *
 * Without this node, StarterKit's schema has no rule for the custom FAQ divs, so
 * loading a rendered article into the editor silently strips the widget down to
 * bare `<p>` tags — which then gets published, losing the accordion + FAQPage
 * structure (see the 2026-06-09 hitl2 raw-HTML regression).
 *
 * Modelled as an atom: the Q/A pairs live in the `items` attribute and are
 * edited through {@link FaqNodeView}, while `renderHTML` rebuilds the exact
 * widget markup via the shared {@link faqItemsToDomSpec} helper.
 */
export const FaqAccordion = Node.create({
  name: "faqAccordion",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      items: {
        default: [] as FaqItem[],
        // Parse the Q/A pairs out of the rendered widget on load.
        parseHTML: (el) => parseFaqElement(el as HTMLElement),
        // Items are re-emitted as real markup by renderHTML, never as an attr.
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    // Priority above the default so the whole widget is captured as one atom
    // before any inner element is parsed by another rule.
    return [{ tag: "div.editor__faq", priority: 200 }];
  },

  renderHTML({ node }) {
    const items = (node.attrs.items as FaqItem[] | undefined) ?? [];
    return faqItemsToDomSpec(items);
  },

  addNodeView() {
    return ReactNodeViewRenderer(FaqNodeView);
  },
});
