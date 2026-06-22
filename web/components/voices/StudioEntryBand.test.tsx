import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { StudioEntryBand } from "@/components/voices/StudioEntryBand";

describe("StudioEntryBand", () => {
  it("renders a primary CTA naming the selected voice with the correct href", () => {
    render(<StudioEntryBand slug="bowtie-editor" />);

    const cta = screen.getByRole("link", { name: /open bowtie-editor in studio/i });
    expect(cta).toHaveAttribute("href", "/voices/bowtie-editor");
  });

  it("encodes the slug in the href", () => {
    render(<StudioEntryBand slug="voice with space" />);

    const cta = screen.getByRole("link", { name: /open voice with space in studio/i });
    expect(cta).toHaveAttribute("href", "/voices/voice%20with%20space");
  });

  it("renders a disabled placeholder (no link) when no voice is selected", () => {
    render(<StudioEntryBand slug={null} />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // A disabled CTA affordance is still present, marked unavailable.
    const placeholder = screen.getByRole("button", { name: /open in studio/i });
    expect(placeholder).toBeDisabled();
    expect(screen.getByText(/select a voice/i)).toBeInTheDocument();
  });

  it("always renders the kicker and descriptor", () => {
    render(<StudioEntryBand slug="bowtie-editor" />);

    expect(screen.getByText(/voice studio/i)).toBeInTheDocument();
    expect(screen.getByText(/pipeline/i)).toBeInTheDocument();
  });
});
