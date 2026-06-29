import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReviewThreadList } from "@/components/ReviewThreadList";
import type { ReviewThread } from "@/lib/types";

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    thread_id: "t-1",
    run_id: "run-1",
    anchor_id: "r-1",
    anchor_text: "the lede",
    status: "open",
    messages: [
      {
        id: "m-1",
        author_email: "ann@bowtie.com.hk",
        author_name: "Ann Editor",
        body: "This needs a citation.",
        created_at: "2026-06-09T10:00:00.000Z",
      },
    ],
    created_by: "ann@bowtie.com.hk",
    created_by_name: "Ann Editor",
    created_at: "2026-06-09T10:00:00.000Z",
    resolved_by: null,
    resolved_by_name: null,
    resolved_at: null,
    updated_at: "2026-06-09T10:00:00.000Z",
    ...over,
  };
}

const noop = () => {};

describe("ReviewThreadList", () => {
  it("shows the empty state when there are no threads", () => {
    render(
      <ReviewThreadList
        threads={[]}
        focusedId={null}
        onFocus={noop}
        onReply={noop}
        onResolve={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText(/No review notes yet/i)).toBeInTheDocument();
  });

  it("renders a thread's anchor, author name, and message body", () => {
    render(
      <ReviewThreadList
        threads={[thread()]}
        focusedId={null}
        onFocus={noop}
        onReply={noop}
        onResolve={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText(/the lede/)).toBeInTheDocument();
    expect(screen.getByText("Ann Editor")).toBeInTheDocument();
    expect(screen.getByText("This needs a citation.")).toBeInTheDocument();
  });

  it("hides resolved threads under the default 'open' filter", () => {
    render(
      <ReviewThreadList
        threads={[thread({ status: "resolved" })]}
        focusedId={null}
        onFocus={noop}
        onReply={noop}
        onResolve={noop}
        onDelete={noop}
      />,
    );
    expect(screen.queryByText("This needs a citation.")).not.toBeInTheDocument();
    expect(screen.getByText(/No open threads/i)).toBeInTheDocument();
  });

  it("reveals a resolved thread when the 'resolved' filter is chosen", async () => {
    render(
      <ReviewThreadList
        threads={[thread({ status: "resolved" })]}
        focusedId={null}
        onFocus={noop}
        onReply={noop}
        onResolve={noop}
        onDelete={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /resolved \(1\)/i }));
    expect(screen.getByText("This needs a citation.")).toBeInTheDocument();
  });

  it("fires onReply with the typed body", async () => {
    const onReply = vi.fn();
    render(
      <ReviewThreadList
        threads={[thread()]}
        focusedId="t-1"
        onFocus={noop}
        onReply={onReply}
        onResolve={noop}
        onDelete={noop}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText(/Reply/i), "Added it.");
    await userEvent.click(screen.getByRole("button", { name: /^reply$/i }));
    expect(onReply).toHaveBeenCalledWith("t-1", "Added it.");
  });

  it("fires onResolve(true) from the Resolve action", async () => {
    const onResolve = vi.fn();
    const t = thread();
    render(
      <ReviewThreadList
        threads={[t]}
        focusedId="t-1"
        onFocus={noop}
        onReply={noop}
        onResolve={onResolve}
        onDelete={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^resolve$/i }));
    expect(onResolve).toHaveBeenCalledWith(t, true);
  });

  it("fires onDelete from the Delete action once confirmed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onDelete = vi.fn();
    const t = thread();
    render(
      <ReviewThreadList
        threads={[t]}
        focusedId="t-1"
        onFocus={noop}
        onReply={noop}
        onResolve={noop}
        onDelete={onDelete}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /delete thread/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith(t);
    confirmSpy.mockRestore();
  });

  it("does not delete when the confirm is dismissed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDelete = vi.fn();
    render(
      <ReviewThreadList
        threads={[thread()]}
        focusedId="t-1"
        onFocus={noop}
        onReply={noop}
        onResolve={noop}
        onDelete={onDelete}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /delete thread/i }));
    expect(onDelete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
