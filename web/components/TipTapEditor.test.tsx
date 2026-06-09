import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TipTapEditor } from "@/components/TipTapEditor";

/**
 * Observer / read-only behaviour of the visual editor. The full editing path is
 * covered by the collab round-trip + page tests; here we assert the read-only
 * contract: no editing toolbar, but the article body still renders.
 */
describe("TipTapEditor — editability", () => {
  it("shows the editing toolbar when editable (default)", async () => {
    render(<TipTapEditor value="<p>hello</p>" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("Bold (⌘B)")).toBeInTheDocument());
  });

  it("hides the toolbar in observer mode (editable=false) but still renders the body", async () => {
    const { container } = render(
      <TipTapEditor value="<p>hello</p>" onChange={() => {}} editable={false} />,
    );
    // The editor mounts (loading placeholder clears)…
    await waitFor(() =>
      expect(screen.queryByText("Loading editor…")).not.toBeInTheDocument(),
    );
    // …but no editing controls are offered to a read-only observer…
    expect(screen.queryByLabelText("Bold (⌘B)")).not.toBeInTheDocument();
    // …and the prose surface is still present.
    expect(container.querySelector(".editorial-prose")).toBeTruthy();
  });
});
