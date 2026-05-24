import { Mark, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentAnchor: {
      setCommentAnchor: (attributes: { commentId: string }) => ReturnType;
      unsetCommentAnchor: (commentId: string) => ReturnType;
    };
  }
}

export const CommentAnchor = Mark.create({
  name: "commentAnchor",

  inclusive: false,

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-comment-id"),
        renderHTML: (attrs) =>
          attrs.commentId ? { "data-comment-id": attrs.commentId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "comment-anchor" }),
      0,
    ];
  },

  addCommands() {
    return {
      setCommentAnchor:
        (attrs) =>
        ({ commands }) =>
          commands.setMark(this.name, attrs),
      unsetCommentAnchor:
        (commentId) =>
        ({ tr, state, dispatch }) => {
          let removed = false;
          state.doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type.name === this.name && mark.attrs.commentId === commentId) {
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
