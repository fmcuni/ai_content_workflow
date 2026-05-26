"use client";

import { cn } from "@/lib/utils";
import type { Persona } from "@/lib/types";

interface RolodexProps {
  personas: Persona[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onNewVoice: () => void;
}

export function Rolodex({ personas, selectedSlug, onSelect, onNewVoice }: RolodexProps) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {personas.map((p) => {
        const active = p.slug === selectedSlug;
        return (
          <button
            type="button"
            key={p.slug}
            onClick={() => onSelect(p.slug)}
            className={cn(
              "shrink-0 w-[200px] text-left px-4 py-3 border border-rule",
              "transition-colors hover:bg-paper-deep/60",
              active && "border-accent",
              p.is_archived && "opacity-50",
            )}
          >
            <p
              className="font-display text-[20px] leading-tight text-ink truncate"
              style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
            >
              {p.name}
            </p>
            <p className="mt-1 font-mono text-[10px] tracking-wider text-ink-faint uppercase truncate">
              {p.slug}
            </p>
            {active && <div className="mt-2 h-px bg-accent" />}
            {p.is_archived && (
              <p className="mt-1 font-mono text-[10px] text-ink-faint">archived</p>
            )}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onNewVoice}
        className="shrink-0 w-[200px] px-4 py-3 border border-dashed border-rule text-ink-faint hover:text-ink hover:border-ink-soft transition-colors text-left"
      >
        <p
          className="font-display text-[20px] leading-tight"
          style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
        >
          ＋ New voice
        </p>
        <p className="mt-1 font-mono text-[10px] tracking-wider uppercase">draft a new voice</p>
      </button>
    </div>
  );
}
