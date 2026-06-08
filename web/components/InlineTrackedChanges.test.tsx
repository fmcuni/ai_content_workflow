import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InlineTrackedChanges } from "@/components/InlineTrackedChanges";
import { computeTrackedChanges } from "@/lib/tracked-changes";

const noop = () => {};

describe("InlineTrackedChanges", () => {
  it("shows the empty state when committed === working", () => {
    render(
      <InlineTrackedChanges
        committed="<p>same</p>"
        working="<p>same</p>"
        onChange={noop}
        onComment={noop}
      />,
    );
    expect(screen.getByText(/No pending changes/i)).toBeInTheDocument();
  });

  it("renders the diff inline as <ins>/<del> with a pending count", () => {
    const { container } = render(
      <InlineTrackedChanges
        committed="<p>hello world</p>"
        working="<p>hello there</p>"
        onChange={noop}
        onComment={noop}
      />,
    );
    expect(screen.getByText(/pending change/i)).toBeInTheDocument();
    expect(container.querySelector('ins[data-tc="add"]')).not.toBeNull();
    expect(container.querySelector('del[data-tc="del"]')).not.toBeNull();
  });

  it("Accept all makes committed equal working", async () => {
    const onChange = vi.fn();
    render(
      <InlineTrackedChanges
        committed="<p>hello</p>"
        working="<p>hello world</p>"
        onChange={onChange}
        onComment={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /accept all/i }));
    const result = onChange.mock.calls[0]![0] as { committed: string; working: string };
    expect(result.committed).toBe(result.working);
    expect(result.working).toBe("<p>hello world</p>");
  });

  it("Reject all reverts working to the committed baseline", async () => {
    const onChange = vi.fn();
    render(
      <InlineTrackedChanges
        committed="<p>hello</p>"
        working="<p>hello world</p>"
        onChange={onChange}
        onComment={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /reject all/i }));
    const result = onChange.mock.calls[0]![0] as { committed: string; working: string };
    expect(result.committed).toBe("<p>hello</p>");
    expect(result.working).toBe("<p>hello</p>");
  });

  it("clicking a change opens the popover; Accept resolves that hunk", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <InlineTrackedChanges
        committed="<p>hello</p>"
        working="<p>hello world</p>"
        onChange={onChange}
        onComment={noop}
      />,
    );
    const ins = container.querySelector('ins[data-tc="add"]') as HTMLElement;
    await userEvent.click(ins);
    const acceptBtn = await screen.findByRole("button", { name: /^accept change$/i });
    await userEvent.click(acceptBtn);
    const result = onChange.mock.calls.at(-1)![0] as { committed: string; working: string };
    // Accepting the sole insertion clears all pending changes.
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("Comment on a change fires onComment with the tag-stripped text", async () => {
    const onComment = vi.fn();
    const { container } = render(
      <InlineTrackedChanges
        committed="<p>hello</p>"
        working="<p>hello world</p>"
        onChange={noop}
        onComment={onComment}
      />,
    );
    const ins = container.querySelector('ins[data-tc="add"]') as HTMLElement;
    await userEvent.click(ins);
    await userEvent.click(await screen.findByRole("button", { name: /comment on change/i }));
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0]![0]).toContain("world");
  });
});
