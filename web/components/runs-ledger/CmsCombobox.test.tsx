import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CmsCombobox, type CmsOption } from "./CmsCombobox";

const OPTIONS: CmsOption[] = [
  { id: 1, name: "Alice Chan", slug: "alice" },
  { id: 2, name: "Bob Wong", slug: "bob" },
];

describe("CmsCombobox", () => {
  it("renders the loading branch as a disabled `Loading…` input", () => {
    render(<CmsCombobox value={null} onChange={vi.fn()} options={[]} tag="WP" loading />);
    const input = screen.getByPlaceholderText("Loading…");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("aria-busy", "true");
  });

  it("renders the error branch as a `Failed — retry` button that calls onRetry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <CmsCombobox
        value={null}
        onChange={vi.fn()}
        options={OPTIONS}
        tag="WP"
        error="network down"
        onRetry={onRetry}
      />,
    );
    const btn = screen.getByRole("button", { name: "Failed — retry" });
    await user.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the selected value as `name · TAG#id` in the input", () => {
    render(<CmsCombobox value={1} onChange={vi.fn()} options={OPTIONS} tag="WP" />);
    // Base UI renders the selected item's string label into the input value.
    const input = screen.getByRole<HTMLInputElement>("combobox");
    expect(input.value).toBe("Alice Chan · WP#1");
  });

  it("renders option labels as `name · TAG#id` once the listbox is open", async () => {
    const user = userEvent.setup();
    render(<CmsCombobox value={null} onChange={vi.fn()} options={OPTIONS} tag="WP" />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    // The popup is portalled; assert the formatted option label is present.
    expect(await screen.findByText("Alice Chan · WP#1")).toBeInTheDocument();
    expect(screen.getByText("Bob Wong · WP#2")).toBeInTheDocument();
  });
});
