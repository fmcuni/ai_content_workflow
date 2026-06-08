import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Hitl2Comment, Hitl2Request } from "@/lib/types";

// Mock the API so WordPressMetaForm's wp-users / wp-categories queries never
// hit the network — keeps the rail render deterministic.
vi.mock("@/lib/api", () => ({
  api: {
    listWpUsers: vi.fn(() => Promise.resolve([])),
    listWpCategories: vi.fn(() => Promise.resolve([])),
  },
}));

import { EditorRail } from "@/components/run-editor/EditorRail";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const FORM: Hitl2Request = { decision: "approve", wp_publish_status: "draft" };

interface RailHarnessProps {
  tab?: "wp" | "comments";
  comments?: Hitl2Comment[];
  notesValue?: string;
  onTabChange?: (t: "wp" | "comments") => void;
  onRequestEdit?: () => void;
  requesting?: boolean;
  requestEnabled?: boolean;
}

function renderRail({
  tab = "wp",
  comments = [],
  notesValue = "",
  onTabChange = () => {},
  onRequestEdit = () => {},
  requesting = false,
  requestEnabled = false,
}: RailHarnessProps = {}) {
  return wrap(
    <EditorRail
      tab={tab}
      onTabChange={onTabChange}
      form={FORM}
      onFormChange={() => {}}
      existingAuthorName={null}
      existingCategoryName={null}
      comments={comments}
      focusedCommentId={null}
      onCommentChange={() => {}}
      onCommentDelete={() => {}}
      onCommentFocus={() => {}}
      notesValue={notesValue}
      onNotesChange={() => {}}
      onRequestEdit={onRequestEdit}
      requesting={requesting}
      requestEnabled={requestEnabled}
    />,
  );
}

describe("EditorRail", () => {
  it("renders both tab triggers, defaulting to the WP metadata form", () => {
    renderRail({ tab: "wp" });
    expect(screen.getByRole("tab", { name: /WP metadata/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /AI to edit/ })).toBeInTheDocument();
    expect(screen.getByText("SEO title")).toBeInTheDocument();
  });

  it("shows the comment count badge on the AI-to-edit tab", () => {
    const comments: Hitl2Comment[] = [
      { id: "c1", anchor_text: "lede", body: "fix" },
      { id: "c2", anchor_text: "kicker", body: "tighten" },
    ];
    renderRail({ comments });
    expect(screen.getByRole("tab", { name: /AI to edit/ })).toHaveTextContent("(2)");
  });

  it("calls onTabChange when the AI-to-edit tab is clicked", async () => {
    const onTabChange = vi.fn();
    renderRail({ onTabChange });
    await userEvent.click(screen.getByRole("tab", { name: /AI to edit/ }));
    expect(onTabChange).toHaveBeenCalledWith("comments");
  });

  it("renders the whole-article-change field on the AI-to-edit tab", () => {
    renderRail({ tab: "comments", notesValue: "punchier lede" });
    expect(screen.getByText("Whole article change")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("punchier lede");
  });

  it("disables Request AI to edit when there is nothing to act on", () => {
    renderRail({ tab: "comments", requestEnabled: false });
    expect(screen.getByRole("button", { name: /request ai to edit/i })).toBeDisabled();
  });

  it("fires onRequestEdit when the enabled button is clicked", async () => {
    const onRequestEdit = vi.fn();
    renderRail({ tab: "comments", requestEnabled: true, onRequestEdit });
    await userEvent.click(screen.getByRole("button", { name: /request ai to edit/i }));
    expect(onRequestEdit).toHaveBeenCalledTimes(1);
  });

  it("shows 'Requesting…' and disables the button while in flight", () => {
    renderRail({ tab: "comments", requestEnabled: true, requesting: true });
    const button = screen.getByRole("button", { name: /requesting/i });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Requesting…");
  });
});
