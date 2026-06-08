import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TrackedChangesView } from "@/components/TrackedChangesView";

const noop = () => {};

describe("TrackedChangesView", () => {
  it("shows the empty state when committed === working", () => {
    render(
      <TrackedChangesView
        committed="<p>same</p>"
        working="<p>same</p>"
        onChange={noop}
        onComment={noop}
      />,
    );
    expect(screen.getByText(/No pending changes/i)).toBeInTheDocument();
  });

  it("renders a pending-count and commit/dismiss-all controls when changes exist", () => {
    render(
      <TrackedChangesView
        committed="<p>hello</p>"
        working="<p>hello world</p>"
        onChange={noop}
        onComment={noop}
      />,
    );
    expect(screen.getByText(/pending change/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /commit all/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss all/i })).toBeInTheDocument();
  });

  it("commit-all makes committed equal working (no pending left)", async () => {
    const onChange = vi.fn();
    render(
      <TrackedChangesView
        committed="<p>hello</p>"
        working="<p>hello world</p>"
        onChange={onChange}
        onComment={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /commit all/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const result = onChange.mock.calls[0]![0] as { committed: string; working: string };
    expect(result.committed).toBe(result.working);
    expect(result.working).toBe("<p>hello world</p>");
  });

  it("dismiss-all reverts working to the committed baseline", async () => {
    const onChange = vi.fn();
    render(
      <TrackedChangesView
        committed="<p>hello</p>"
        working="<p>hello world</p>"
        onChange={onChange}
        onComment={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /dismiss all/i }));
    const result = onChange.mock.calls[0]![0] as { committed: string; working: string };
    expect(result.committed).toBe("<p>hello</p>");
    expect(result.working).toBe("<p>hello</p>");
  });

  it("fires onComment with the change text stripped of tags", async () => {
    const onComment = vi.fn();
    render(
      <TrackedChangesView
        committed="<p>hello</p>"
        working="<p>hello world</p>"
        onChange={noop}
        onComment={onComment}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /comment on change/i }));
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0]![0]).toContain("world");
  });
});
