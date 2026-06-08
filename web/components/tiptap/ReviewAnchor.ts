import { Mark, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    reviewAnchor: {
      setReviewAnchor: (attributes: { reviewId: string }) => ReturnType;
      setReviewAnchorResolved: (reviewId: string, resolved: boolean) => ReturnType;
      unsetReviewAnchor: (reviewId: string) => ReturnType;
    };
  }
}

/**
 * Highlight mark for HUMAN review threads — a SEPARATE annotation from the
 * AI-edit `CommentAnchor` (`data-comment-id` / `.comment-anchor`). Review
 * anchors carry `data-review-id` + `.review-anchor`, and a `data-resolved` flag
 * so a resolved thread's highlight can dim. Both marks coexist on the same body
 * without colliding in parse/serialize.
 */
export const ReviewAnchor = Mark.create({
  name: "reviewAnchor",

  inclusive: false,

  addAttributes() {
    return {
      reviewId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-review-id"),
        renderHTML: (attrs) =>
          attrs.reviewId ? { "data-review-id": attrs.reviewId } : {},
      },
      resolved: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-resolved") === "true",
        renderHTML: (attrs) =>
          attrs.resolved ? { "data-resolved": "true" } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-review-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "review-anchor" }),
      0,
    ];
  },

  addCommands() {
    return {
      setReviewAnchor:
        (attrs) =>
        ({ commands }) =>
          commands.setMark(this.name, attrs),
      setReviewAnchorResolved:
        (reviewId, resolved) =>
        ({ tr, state, dispatch }) => {
          let changed = false;
          state.doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type.name === this.name && mark.attrs.reviewId === reviewId) {
                tr.addMark(
                  pos,
                  pos + node.nodeSize,
                  mark.type.create({ ...mark.attrs, resolved }),
                );
                changed = true;
              }
            });
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
      unsetReviewAnchor:
        (reviewId) =>
        ({ tr, state, dispatch }) => {
          let removed = false;
          state.doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type.name === this.name && mark.attrs.reviewId === reviewId) {
                tr.removeMark(pos, pos + node.nodeSize, mark);
                removed = true;
              }
            });
          });
          if (removed && dispatch) dispatch(tr);
          return removed;
        },
    };
  },
});
