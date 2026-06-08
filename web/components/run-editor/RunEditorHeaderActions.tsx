"use client";
import type { SaveState } from "@/lib/run-editor/useSnapshotAutosave";

interface RunEditorHeaderActionsProps {
  saveStatusLabel: string;
  saveState: SaveState;
  isDirty: boolean;
  /** Author role gate — disables the Save button + shows the hint when false. */
  canEdit: boolean;
  onSave: () => void;
  onOpenHistory: () => void;
}

/**
 * The shared run-editor header cluster: autosave status, a manual "⤓ Save", and
 * "⟲ Version history". Rendered on the right of the back-link row (the shell's
 * `headerActions` slot) so /hitl2 and /edit present an identical toolbar.
 */
export function RunEditorHeaderActions({
  saveStatusLabel,
  saveState,
  isDirty,
  canEdit,
  onSave,
  onOpenHistory,
}: RunEditorHeaderActionsProps) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`font-mono text-[11px] uppercase tracking-wider ${
          saveState === "error" ? "text-accent-deep" : isDirty ? "text-accent" : "text-ink-faint"
        }`}
      >
        {saveState === "saving" && "↻ "}
        {saveStatusLabel}
      </span>
      <button
        type="button"
        onClick={onSave}
        disabled={!isDirty || saveState === "saving" || !canEdit}
        title={!canEdit ? "Author role required to save edits." : undefined}
        className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-ink-faint"
      >
        {saveState === "saving" ? "↻ Saving…" : "⤓ Save"}
      </button>
      <button
        type="button"
        onClick={onOpenHistory}
        className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider"
      >
        ⟲ Version history
      </button>
    </div>
  );
}
