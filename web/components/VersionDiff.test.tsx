import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VersionDiff } from "./VersionDiff";

describe("VersionDiff", () => {
  it("shows the empty label when before and after match", () => {
    // Arrange + Act
    render(<VersionDiff before={"same\nbody"} after={"same\nbody"} emptyLabel="Identical." />);

    // Assert
    expect(screen.getByText("Identical.")).toBeInTheDocument();
  });

  it("renders added and removed lines when they differ", () => {
    // Arrange + Act
    render(<VersionDiff before={"old line\n"} after={"new line\n"} />);

    // Assert
    expect(screen.getByText("old line")).toBeInTheDocument();
    expect(screen.getByText("new line")).toBeInTheDocument();
  });
});
