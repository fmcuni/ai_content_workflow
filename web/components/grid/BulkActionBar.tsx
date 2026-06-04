"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BULK_ACTIONS,
  type BulkActionDef,
  type BulkActionKey,
  planRunAction,
  useBulkActions,
} from "@/lib/runs-grid/use-bulk-actions";
import { useRole } from "@/lib/use-role";
import type { RunSummary, TopicBatch } from "@/lib/types";
import { cn } from "@/lib/utils";

// Arrow keys that move focus within the role="toolbar" (WAI-ARIA toolbar pattern).
const TOOLBAR_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

// Phase 4 bulk action bar — a fixed, bottom-centre band that appears once at
// least one row is selected. Mirrors the demo's `.bulkbar`: a count, role-gated
// action buttons, and a Clear. Each button opens a confirm or pick dialog before
// any fan-out; a Publish/Republish that touches a live post forces an explicit
// count-confirmation ("Publish N posts — M LIVE"), never a single click.

interface BulkActionBarProps {
  selected: ReadonlySet<string>;
  runsById: ReadonlyMap<string, RunSummary>;
  batchesById: ReadonlyMap<string, TopicBatch>;
  wpUsers: ReadonlyMap<number, string>;
  wpCategories: ReadonlyMap<number, string>;
  onClear: () => void;
}

// Empty-eligibility copy per status-gated action (no silent no-op — we tell the
// operator nothing matched).
const EMPTY_COPY: Partial<Record<BulkActionKey, string>> = {
  approve: "No selected runs are at HITL_1.",
  publish: "No selected runs are at HITL_2.",
  republish: "No selected runs are saved or published.",
  restart: "No selected runs are failed.",
};

interface ConfirmState {
  mode: "confirm";
  action: BulkActionKey;
  title: string;
  body: string;
  danger: boolean;
  onConfirm: () => void;
}
interface PickState {
  mode: "pick";
  action: BulkActionKey;
  title: string;
  options: { value: string; label: string }[];
  onConfirm: (value: string) => void;
}
type DialogState = ConfirmState | PickState;

const BBTN =
  "font-sans text-[11.5px] font-medium rounded-sm px-2.5 py-[5px] whitespace-nowrap cursor-pointer " +
  "border border-paper/30 bg-transparent text-paper hover:bg-paper/15 transition-colors";
const BBTN_LIVE = "border-[#e88a72] text-[#f4c4b6]";
const BBTN_DANGER = "hover:bg-accent-deep/50";

export function BulkActionBar({
  selected,
  runsById,
  batchesById,
  wpUsers,
  wpCategories,
  onClear,
}: BulkActionBarProps) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const { execute } = useBulkActions();
  const { can } = useRole();

  // Only the actions this operator's role allows are shown — the bar then drives
  // a proper roving-tabindex toolbar over that visible set.
  const visibleActions = useMemo(() => BULK_ACTIONS.filter((d) => can(d.need)), [can]);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<BulkActionKey | null>(null);
  // Keep the roving cursor valid as the visible set changes (render-time, not an
  // effect): default to the first action, recover if the focused one disappears.
  const rovingKey =
    focusKey && visibleActions.some((d) => d.key === focusKey)
      ? focusKey
      : visibleActions[0]?.key ?? null;

  function onToolbarKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!TOOLBAR_KEYS.has(event.key)) return;
    event.preventDefault();
    const keys = visibleActions.map((d) => d.key);
    if (keys.length === 0) return;
    const idx = rovingKey ? keys.indexOf(rovingKey) : 0;
    const next =
      event.key === "ArrowRight" ? (idx + 1) % keys.length
      : event.key === "ArrowLeft" ? (idx - 1 + keys.length) % keys.length
      : event.key === "Home" ? 0
      : keys.length - 1;
    const nextKey = keys[next];
    setFocusKey(nextKey);
    toolbarRef.current
      ?.querySelector<HTMLButtonElement>(`[data-bulk-key="${nextKey}"]`)
      ?.focus();
  }

  const selectedRuns = useMemo(
    () => [...selected].map((id) => runsById.get(id)).filter((r): r is RunSummary => r != null),
    [selected, runsById],
  );
  const selectedBatches = useMemo(
    () => [...selected].map((id) => batchesById.get(id)).filter((b): b is TopicBatch => b != null),
    [selected, batchesById],
  );

  if (selected.size === 0 && dialog === null) return null;

  function pickValue(value: string) {
    if (dialog?.mode === "pick") {
      dialog.onConfirm(value);
      setDialog(null);
    }
  }
  function confirm() {
    if (dialog?.mode === "confirm") {
      dialog.onConfirm();
      setDialog(null);
    }
  }

  /** Fire the fan-out then clear the selection (the hook surfaces the summary). */
  function fire(vars: Parameters<typeof execute>[0]) {
    execute(vars);
    onClear();
  }

  function onAction(def: BulkActionDef) {
    const { key } = def;

    if (key === "assign_author" || key === "assign_category") {
      if (selectedRuns.length === 0) {
        toast.error("Select runs first.");
        return;
      }
      const isAuthor = key === "assign_author";
      const map = isAuthor ? wpUsers : wpCategories;
      const options = [...map.entries()].map(([id, label]) => ({ value: String(id), label }));
      setDialog({
        mode: "pick",
        action: key,
        title: `${isAuthor ? "Assign author" : "Assign category"} to ${selectedRuns.length} run(s)`,
        options,
        onConfirm: (value) => {
          const id = Number(value);
          fire(
            isAuthor
              ? { action: key, runs: selectedRuns, params: { authorId: id } }
              : { action: key, runs: selectedRuns, params: { categoryIds: [id] } },
          );
        },
      });
      return;
    }

    if (key === "delete") {
      const total = selectedRuns.length + selectedBatches.length;
      if (total === 0) return;
      const batchNote = selectedBatches.length > 0 ? ` and ${selectedBatches.length} batch(es)` : "";
      setDialog({
        mode: "confirm",
        action: key,
        title: `Remove ${total} record(s)?`,
        body: `${selectedRuns.length} run(s)${batchNote} and derived work permanently deleted. Live WordPress posts are unaffected.`,
        danger: true,
        onConfirm: () => fire({ action: key, runs: selectedRuns, batches: selectedBatches }),
      });
      return;
    }

    // Status-gated lifecycle actions: approve / publish / republish / restart.
    const plan = planRunAction(key, selectedRuns);
    if (plan.eligible.length === 0) {
      toast.error(EMPTY_COPY[key] ?? "No eligible runs selected.");
      return;
    }
    const n = plan.eligible.length;
    const skippedNote = plan.skipped > 0 ? ` ${plan.skipped} ineligible skipped.` : "";
    const live = def.publishes ? plan.live : 0;

    let title: string;
    let body: string;
    switch (key) {
      case "approve":
        title = `Approve ${n} outline(s)?`;
        body = `${n} run(s) at HITL_1 approved.${skippedNote}`;
        break;
      case "publish":
        title = `Publish ${n} post(s)${live > 0 ? ` — ${live} LIVE` : ""}?`;
        body = `${n} run(s) at HITL_2 approved & published.${skippedNote}`;
        break;
      case "republish":
        title = `Republish ${n}${live > 0 ? ` — ${live} LIVE` : ""}?`;
        body = `Re-push ${n} run(s) with current metadata.${skippedNote}`;
        break;
      default:
        title = `Restart ${n} failed run(s)?`;
        body = `${n} failed run(s) re-run from the top.${skippedNote}`;
    }
    setDialog({
      mode: "confirm",
      action: key,
      title,
      body,
      danger: live > 0,
      onConfirm: () => fire({ action: key, runs: plan.eligible }),
    });
  }

  return (
    <>
      {selected.size > 0 ? (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label="Bulk actions"
          onKeyDown={onToolbarKeyDown}
          className={cn(
            "fixed left-1/2 bottom-[22px] -translate-x-1/2 z-[60] flex items-center gap-2 flex-wrap",
            "bg-ink text-paper rounded px-4 py-2.5 shadow-[0_8px_30px_rgba(0,0,0,0.25)] max-w-[96vw]",
          )}
        >
          <span className="font-mono text-[12px] mr-1.5 whitespace-nowrap">
            <b className="text-paper tabular-nums">{selected.size}</b> selected
          </span>
          <span aria-hidden className="w-px h-5 bg-paper/25 mx-0.5" />
          {visibleActions.map((def) => (
            <button
              key={def.key}
              type="button"
              data-bulk-key={def.key}
              tabIndex={def.key === rovingKey ? 0 : -1}
              onClick={() => onAction(def)}
              onFocus={() => setFocusKey(def.key)}
              className={cn(BBTN, def.publishes && BBTN_LIVE, def.danger && BBTN_DANGER)}
            >
              {def.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onClear}
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#c9b9a0] bg-transparent border-0 cursor-pointer ml-1"
          >
            Clear
          </button>
        </div>
      ) : null}

      <Dialog open={dialog !== null} onOpenChange={(open) => (open ? null : setDialog(null))}>
        {dialog ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{dialog.title}</DialogTitle>
              {dialog.mode === "confirm" ? (
                <DialogDescription>{dialog.body}</DialogDescription>
              ) : (
                <DialogDescription>Choose a value to apply across the selected runs.</DialogDescription>
              )}
            </DialogHeader>

            {dialog.mode === "confirm" && dialog.danger ? (
              <div
                role="alert"
                className="border-l-2 border-accent bg-accent/[0.07] px-3 py-2 text-[12.5px] text-accent-deep"
              >
                <span aria-hidden="true">⚠</span> Hard to undo — confirm the count above before
                publishing live.
              </div>
            ) : null}

            {dialog.mode === "pick" ? (
              <PickField options={dialog.options} onPick={pickValue} />
            ) : (
              <DialogFooter>
                <button
                  type="button"
                  onClick={() => setDialog(null)}
                  className="font-sans text-[12px] font-medium rounded-sm px-3 py-1.5 border border-rule text-ink hover:border-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirm}
                  className={cn(
                    "font-sans text-[12px] font-medium rounded-sm px-3 py-1.5 border",
                    dialog.danger
                      ? "border-accent-deep text-accent-deep hover:bg-accent-deep hover:text-paper"
                      : "border-ink bg-ink text-paper hover:bg-accent hover:border-accent",
                  )}
                >
                  Confirm
                </button>
              </DialogFooter>
            )}
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

/** A single-value picker used by the Assign author / category dialogs. */
function PickField({
  options,
  onPick,
}: {
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
}) {
  const [value, setValue] = useState(options[0]?.value ?? "");
  return (
    <DialogFooter className="sm:flex-col sm:items-stretch sm:justify-stretch">
      <select
        aria-label="Value to assign"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full border border-rule rounded-sm bg-paper px-2.5 py-2 text-[13px] text-ink mb-2"
      >
        {options.length === 0 ? <option value="">No options available</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={value === ""}
        onClick={() => onPick(value)}
        className="font-sans text-[12px] font-medium rounded-sm px-3 py-1.5 border border-ink bg-ink text-paper hover:bg-accent hover:border-accent disabled:opacity-50"
      >
        Apply
      </button>
    </DialogFooter>
  );
}
