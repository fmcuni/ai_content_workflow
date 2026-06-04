"use client";

import { useId } from "react";

import { Switch } from "@/components/ui/switch";

interface AutoAcceptFieldProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Override the hint for fronts where the run is one step removed (Front II). */
  hint?: string;
  disabled?: boolean;
}

const DEFAULT_HINT =
  "Runs skip the HITL_1 outline / gap-analysis review and go straight to drafting. The draft still stops for you at HITL_2 before publishing.";

/**
 * Shared editorial toggle for "auto-approve the HITL_1 outline gate", used on all
 * three new-run fronts. Keeps the copy and affordance identical so operators read
 * the same promise everywhere.
 */
export function AutoAcceptField({ checked, onChange, hint = DEFAULT_HINT, disabled }: AutoAcceptFieldProps) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 border border-rule bg-paper-deep/40 px-4 py-3">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <label htmlFor={id} className="min-w-0 cursor-pointer select-none">
        <span className="kicker block">
          Auto-approve outline gate
          {checked ? <span className="text-accent"> · ON</span> : null}
        </span>
        <span className="block font-sans text-[12px] text-ink-soft leading-relaxed mt-1">{hint}</span>
      </label>
    </div>
  );
}
