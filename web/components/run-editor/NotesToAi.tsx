"use client";
import { Sparkles } from "lucide-react";

interface NotesToAiProps {
  value: string;
  onChange: (value: string) => void;
  /** undefined → no Apply button (regenerate case). */
  onApply?: () => void;
  /** Shows "Applying…" + disables the Apply button. */
  applying?: boolean;
}

/**
 * The "Notes to AI" block shared by /hitl2, /edit, and /regenerate. Lets the
 * operator give overall direction for a whole-article AI revision. The "Apply
 * to article" button is omitted when `onApply` is undefined (regenerate).
 */
export function NotesToAi({ value, onChange, onApply, applying = false }: NotesToAiProps) {
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <p className="kicker">Notes to AI</p>
        {onApply && (
          <button
            type="button"
            disabled={value.trim().length === 0 || applying}
            onClick={onApply}
            className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-accent hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-accent"
            title="Let AI revise the whole article from these notes."
          >
            <Sparkles className="h-3 w-3" />
            {applying ? "Applying…" : "Apply to article"}
          </button>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder="Overall direction — e.g. 'lede should be punchier, lead with the surgery question.'"
        className="w-full resize-y border border-rule bg-paper rounded px-3 py-2 text-[14px] text-ink focus:outline-none focus:border-accent"
      />
    </div>
  );
}
