import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RunEditorHeaderActions } from "@/components/run-editor/RunEditorHeaderActions";

const base = {
  saveStatusLabel: "Saved 3:20:17 PM",
  saveState: "saved" as const,
  isDirty: false,
  canEdit: true,
  onSave: () => {},
  onOpenHistory: () => {},
};

describe("RunEditorHeaderActions", () => {
  it("shows the save status and the Save + Version history controls", () => {
    render(<RunEditorHeaderActions {...base} />);
    expect(screen.getByText("Saved 3:20:17 PM")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Version history/ })).toBeInTheDocument();
  });

  it("disables Save when there are no unsaved changes", () => {
    render(<RunEditorHeaderActions {...base} isDirty={false} />);
    expect(screen.getByRole("button", { name: /⤓ Save/ })).toBeDisabled();
  });

  it("enables Save when dirty and editable", () => {
    render(<RunEditorHeaderActions {...base} isDirty />);
    expect(screen.getByRole("button", { name: /⤓ Save/ })).toBeEnabled();
  });

  it("disables Save and hints when the viewer lacks the author role", () => {
    render(<RunEditorHeaderActions {...base} isDirty canEdit={false} />);
    const save = screen.getByRole("button", { name: /⤓ Save/ });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title", "Author role required to save edits.");
  });

  it("disables Save while a save is in flight", () => {
    render(<RunEditorHeaderActions {...base} saveState="saving" saveStatusLabel="Saving…" />);
    expect(screen.getByRole("button", { name: /Saving…/ })).toBeDisabled();
  });

  it("fires onSave and onOpenHistory on click", async () => {
    const onSave = vi.fn();
    const onOpenHistory = vi.fn();
    render(
      <RunEditorHeaderActions {...base} isDirty onSave={onSave} onOpenHistory={onOpenHistory} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /⤓ Save/ }));
    await userEvent.click(screen.getByRole("button", { name: /Version history/ }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });
});
