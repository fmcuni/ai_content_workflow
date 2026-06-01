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

// The module under test does NOT exist yet — this import drives the RED state.
import { EditorRail } from "@/components/run-editor/EditorRail";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const FORM: Hitl2Request = { decision: "approve", wp_publish_status: "draft" };

interface RailHarnessProps {
  tab?: "wp" | "comments";
  comments?: Hitl2Comment[];
  onTabChange?: (t: "wp" | "comments") => void;
  onCommentApply?: (id: string) => void;
}

function renderRail({
  tab = "wp",
  comments = [],
  onTabChange = () => {},
  onCommentApply = () => {},
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
      onCommentApply={onCommentApply}
      applyingCommentId={null}
    />,
  );
}

describe("EditorRail", () => {
  it("renders both tab triggers, defaulting to the WP metadata form", () => {
    renderRail({ tab: "wp" });
    expect(screen.getByRole("tab", { name: /WP metadata/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Comments/ })).toBeInTheDocument();
    expect(screen.getByText("SEO title")).toBeInTheDocument();
  });

  it("shows the comment count badge on the Comments tab", () => {
    const comments: Hitl2Comment[] = [
      { id: "c1", anchor_text: "lede", body: "fix" },
      { id: "c2", anchor_text: "kicker", body: "tighten" },
    ];
    renderRail({ comments });
    expect(screen.getByRole("tab", { name: /Comments/ })).toHaveTextContent("(2)");
  });

  it("calls onTabChange when the Comments tab is clicked", async () => {
    const onTabChange = vi.fn();
    renderRail({ onTabChange });
    await userEvent.click(screen.getByRole("tab", { name: /Comments/ }));
    expect(onTabChange).toHaveBeenCalledWith("comments");
  });

  it("wires onCommentApply with the right id from the comments tab", async () => {
    const onCommentApply = vi.fn();
    const comments: Hitl2Comment[] = [{ id: "c1", anchor_text: "lede", body: "punch this up" }];
    renderRail({ tab: "comments", comments, onCommentApply });
    await userEvent.click(screen.getByRole("button", { name: /apply edit/i }));
    expect(onCommentApply).toHaveBeenCalledWith("c1");
  });
});
