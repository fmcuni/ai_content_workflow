"use client";

import type { Persona } from "@/lib/types";

interface VoiceSelectorProps {
  /** Voices to choose from — typically the non-archived personas. */
  personas: Persona[];
  /** Currently selected voice (persona slug). */
  value: string;
  /** Fired with the newly selected slug. */
  onChange: (slug: string) => void;
}

/**
 * Voice (persona) picker at the top of the Prompt Library. The Prompt Library
 * and Source Policy are scoped per voice; switching here re-scopes both. The
 * server defaults to `bowtie-editor`, mirrored by the page's default selection.
 */
export function VoiceSelector({ personas, value, onChange }: VoiceSelectorProps) {
  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor="prompt-voice"
        className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint"
      >
        Voice
      </label>
      <select
        id="prompt-voice"
        aria-label="Voice"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border border-rule bg-paper px-3 py-1.5 font-sans text-[14px] text-ink focus:outline-none focus-visible:border-accent"
      >
        {personas.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.name}
            {p.is_archived ? " (archived)" : ""}
          </option>
        ))}
      </select>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {value}
      </span>
    </div>
  );
}
