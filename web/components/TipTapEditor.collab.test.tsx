import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Editor, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

import { CommentAnchor } from "@/components/tiptap/CommentAnchor";
import { ReviewAnchor } from "@/components/tiptap/ReviewAnchor";
import { FaqAccordion } from "@/components/tiptap/FaqAccordion";
import type { CollabProvider } from "@/lib/run-editor/useCollabDoc";
import { TipTapEditor } from "@/components/TipTapEditor";

// A small rich fragment exercising the headline fidelity risks: the FaqAccordion
// widget, a table, a link, and CJK text.
const RICH_HTML = `<h2>產品比較</h2>
<p>詳情請見<a href="https://gobowtie.com/my/vhis">官方頁面</a>。</p>
<div class="editor__item editor__faq">
  <div class="e-faq__wrap">
    <div class="e-faq__list is--active">
      <div class="e-faq__head">什麼是自願醫保？<span class="e-faq__icon icon-add"></span></div>
      <div class="e-faq__body" style="display: block;"><p>一項政府計劃。</p></div>
    </div>
  </div>
</div>`;

// The collab editor schema (mirrors TipTapEditor.tsx + collab-roundtrip.test.tsx).
// Used to seed the shared Yjs doc the mounted editor binds to.
function collabExtensions(ydoc: Y.Doc): Extensions {
  return [
    StarterKit.configure({ link: false, undoRedo: false }),
    LinkExtension.configure({ openOnClick: false, autolink: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    CommentAnchor,
    ReviewAnchor,
    FaqAccordion,
    Collaboration.configure({ document: ydoc }),
  ];
}

function makeProvider(doc: Y.Doc): { provider: CollabProvider; awareness: Awareness } {
  const awareness = new Awareness(doc);
  const provider: CollabProvider = { awareness, doc, destroy: () => {} };
  return { provider, awareness };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("TipTapEditor — non-collab (default) path", () => {
  it("mounts the toolbar and renders the supplied value HTML", async () => {
    render(<TipTapEditor value="<p>標準編輯器</p>" onChange={() => {}} />);

    // immediatelyRender:false → editor mounts asynchronously.
    expect(await screen.findByLabelText(/Bold/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("標準編輯器")).toBeInTheDocument());
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("TipTapEditor — collab path", () => {
  it("mounts without throwing and binds to the shared Yjs doc (FAQ + CJK preserved)", async () => {
    // Seed the shared doc through a headless editor on the SAME schema (mirrors
    // collab-roundtrip.test.tsx): the mounted editor reads the doc, not `value`.
    const ydoc = new Y.Doc();
    const seeder = new Editor({
      element: document.createElement("div"),
      extensions: collabExtensions(ydoc),
    });
    seeder.commands.setContent(RICH_HTML);

    const { provider } = makeProvider(ydoc);
    const onChange = vi.fn();

    const { container } = render(
      <TipTapEditor
        value=""
        onChange={onChange}
        collab={{ ydoc, provider, user: { name: "Tester", color: "#ef4444" } }}
      />,
    );

    // Editor mounts (toolbar present) without error.
    expect(await screen.findByLabelText(/Bold/)).toBeInTheDocument();
    // The doc (not the empty `value`) is the source of truth — the CJK heading
    // proves the editor binds to the shared Yjs doc, not the empty `value`.
    await waitFor(() => expect(screen.getByText("產品比較")).toBeInTheDocument());
    // The FaqAccordion atom mounts (its React NodeView container is present),
    // proving the collab schema registers FaqAccordion identically and does not
    // flatten the widget. (Question text lives inside the NodeView, which renders
    // its own DOM — assert the widget container survives, not split text nodes.)
    await waitFor(() =>
      expect(container.querySelector('[data-node-view-wrapper], .editor__faq')).not.toBeNull(),
    );
    expect(errorSpy).not.toHaveBeenCalled();

    seeder.destroy();
  });

  it("does NOT clobber the doc when the external `value` prop changes in collab mode", async () => {
    const ydoc = new Y.Doc();
    const seeder = new Editor({
      element: document.createElement("div"),
      extensions: collabExtensions(ydoc),
    });
    seeder.commands.setContent("<p>原始內容</p>");

    const { provider } = makeProvider(ydoc);
    const { rerender } = render(
      <TipTapEditor
        value="initial"
        onChange={() => {}}
        collab={{ ydoc, provider, user: { name: "Tester", color: "#ef4444" } }}
      />,
    );

    await waitFor(() => expect(screen.getByText("原始內容")).toBeInTheDocument());

    // Change the external value — in collab mode the sync effect early-returns,
    // so the editor content must stay sourced from the doc, NOT reset to `value`.
    rerender(
      <TipTapEditor
        value="<p>外部覆寫</p>"
        onChange={() => {}}
        collab={{ ydoc, provider, user: { name: "Tester", color: "#ef4444" } }}
      />,
    );

    await waitFor(() => expect(screen.getByText("原始內容")).toBeInTheDocument());
    expect(screen.queryByText("外部覆寫")).not.toBeInTheDocument();

    seeder.destroy();
  });
});
