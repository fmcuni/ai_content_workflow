import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The module under test does NOT exist yet — this import drives the RED state.
import { NotesToAi } from "@/components/run-editor/NotesToAi";

describe("NotesToAi", () => {
  it("renders the kicker label and the current value in the textarea", () => {
    render(<NotesToAi value="tighten the lede" onChange={() => {}} />);
    expect(screen.getByText("Notes to AI")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("tighten the lede");
  });

  it("calls onChange as the operator types", async () => {
    const onChange = vi.fn();
    render(<NotesToAi value="" onChange={onChange} />);
    await userEvent.type(screen.getByRole("textbox"), "x");
    expect(onChange).toHaveBeenCalledWith("x");
  });

  it("omits the Apply button when onApply is undefined (regenerate case)", () => {
    render(<NotesToAi value="some notes" onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: /apply/i })).not.toBeInTheDocument();
  });

  it("renders the Apply button when onApply is provided and fires it on click", async () => {
    const onApply = vi.fn();
    render(<NotesToAi value="some notes" onChange={() => {}} onApply={onApply} />);
    const button = screen.getByRole("button", { name: /apply to article/i });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("disables the Apply button when the notes are blank", () => {
    render(<NotesToAi value="   " onChange={() => {}} onApply={() => {}} />);
    expect(screen.getByRole("button", { name: /apply to article/i })).toBeDisabled();
  });

  it("shows 'Applying…' and disables the button while applying", () => {
    render(<NotesToAi value="some notes" onChange={() => {}} onApply={() => {}} applying />);
    const button = screen.getByRole("button", { name: /applying/i });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Applying…");
  });
});
