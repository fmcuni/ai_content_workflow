"use client";

import type { Outline } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Outlined-mode right column (spec §4.5): the proposed article outline. */
export function OutlinePanel({ outline }: { outline: Outline | null }) {
  if (!outline) {
    return <p className="py-3.5 text-[12.5px] italic text-ink-faint">No outline available.</p>;
  }
  return (
    <div>
      <div className="mb-2.5 font-display text-[14.5px] font-semibold leading-snug text-ink">
        {outline.h1}
      </div>
      {outline.sections.map((s, i) => {
        const flag = s.action === "add" ? "add" : "keep";
        return (
          <div key={i} className="mb-3 border-l-2 border-rule pl-2.5">
            <div className="text-[12.5px] font-semibold leading-snug text-ink">
              <span className="mr-1.5 rounded bg-paper-deep px-1 py-px align-[1px] font-mono text-[9.5px] text-ink-faint">
                H{s.heading_level}
              </span>
              {s.heading_text}
              <span
                className={cn(
                  "ml-1.5 rounded px-1 py-px text-[9.5px] font-semibold uppercase",
                  flag === "add" ? "bg-info/10 text-info" : "bg-ink-soft/10 text-ink-soft",
                )}
              >
                {flag}
              </span>
            </div>
            {s.intent && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-soft">{s.intent}</div>}
            {s.key_points.length > 0 && (
              <ul className="ml-4 mt-1 list-disc text-[12px] leading-relaxed text-ink">
                {s.key_points.map((p, j) => (
                  <li key={j}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
