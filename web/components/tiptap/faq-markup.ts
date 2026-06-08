import type { DOMOutputSpec } from "@tiptap/pm/model";

/**
 * One FAQ question/answer pair. The question is plain inline text; the answer is
 * the (single-paragraph) plain text the renderer wraps in `<p>…</p>`.
 */
export interface FaqItem {
  readonly q: string;
  readonly a: string;
}

/**
 * Build the exact Bowtie FAQ-widget DOM the production renderer emits
 * (deploy/cloudflare-workers/src/agents/render.ts → `buildFaqHtml`):
 *
 *   <div class="editor__item editor__faq">
 *     <div class="e-faq__wrap">
 *       <div class="e-faq__list is--active">
 *         <div class="e-faq__head">{q}<span class="e-faq__icon icon-add"></span></div>
 *         <div class="e-faq__body" style="display: block;"><p>{a}</p></div>
 *       </div>
 *       <div class="e-faq__list"> … </div>
 *     </div>
 *   </div>
 *
 * The first item always carries `is--active` and its body the inline
 * `display: block;`, matching the theme reference. This is the single source of
 * truth for serialization, so the editor round-trips the widget unchanged.
 */
export function faqItemsToDomSpec(items: readonly FaqItem[]): DOMOutputSpec {
  const lists: DOMOutputSpec[] = items.map((item, i) => {
    const head: DOMOutputSpec = [
      "div",
      { class: "e-faq__head" },
      item.q,
      ["span", { class: "e-faq__icon icon-add" }],
    ];
    const bodyAttrs =
      i === 0 ? { class: "e-faq__body", style: "display: block;" } : { class: "e-faq__body" };
    const body: DOMOutputSpec = ["div", bodyAttrs, ["p", item.a]];
    const listClass = i === 0 ? "e-faq__list is--active" : "e-faq__list";
    return ["div", { class: listClass }, head, body];
  });
  return ["div", { class: "editor__item editor__faq" }, ["div", { class: "e-faq__wrap" }, ...lists]];
}

/**
 * Inverse of {@link faqItemsToDomSpec}: read the Q/A pairs out of a rendered
 * `div.editor__faq` element. The empty `e-faq__icon` span contributes no text,
 * so `textContent` on the head yields the bare question.
 */
export function parseFaqElement(el: HTMLElement): FaqItem[] {
  const items: FaqItem[] = [];
  el.querySelectorAll(".e-faq__list").forEach((list) => {
    const q = (list.querySelector(".e-faq__head")?.textContent ?? "").trim();
    const a = (list.querySelector(".e-faq__body")?.textContent ?? "").trim();
    if (q || a) {
      items.push({ q, a });
    }
  });
  return items;
}
