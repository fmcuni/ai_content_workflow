import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NotesToAi } from "@/components/run-editor/NotesToAi";

describe("NotesToAi", () => {
  it("renders the default kicker label and the current value in the textarea", () => {
    render(<NotesToAi value="tighten the lede" onChange={() => {}} />);
    expect(screen.getByText("Notes to AI")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("tighten the lede");
  });

  it("renders a custom label when provided", () => {
    render(<NotesToAi value="" onChange={() => {}} label="Whole article change" />);
    expect(screen.getByText("Whole article change")).toBeInTheDocument();
  });

  it("calls onChange as the operator types", async () => {
    const onChange = vi.fn();
    render(<NotesToAi value="" onChange={onChange} />);
    await userEvent.type(screen.getByRole("textbox"), "x");
    expect(onChange).toHaveBeenCalledWith("x");
  });

  it("never renders an apply button (the rail owns the request action)", () => {
    render(<NotesToAi value="some notes" onChange={() => {}} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
