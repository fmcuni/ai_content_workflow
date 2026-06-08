"use client";

interface NotesToAiProps {
  value: string;
  onChange: (value: string) => void;
  /** Kicker label above the textarea. */
  label?: string;
  /** Placeholder shown when the textarea is empty. */
  placeholder?: string;
}

/**
 * A whole-article direction textarea used inside the run-editor "AI to edit"
 * rail on /hitl2 and /edit. It is purely presentational — the AI request is
 * triggered by the rail's single "Request AI to edit" button, not here.
 */
export function NotesToAi({
  value,
  onChange,
  label = "Notes to AI",
  placeholder = "Overall direction — e.g. 'lede should be punchier, lead with the surgery question.'",
}: NotesToAiProps) {
  return (
    <div>
      {label && <p className="kicker mb-2">{label}</p>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={placeholder}
        className="w-full resize-y border border-rule bg-paper rounded px-3 py-2 text-[14px] text-ink focus:outline-none focus:border-accent"
      />
    </div>
  );
}
