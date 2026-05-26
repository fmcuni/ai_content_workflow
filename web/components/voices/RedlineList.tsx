import { cn } from "@/lib/utils";

interface RedlineListProps {
  banned: string[];
  required: string[];
  className?: string;
}

/**
 * Pairs banned terms with required phrasings positionally. If lengths differ,
 * extra entries from the longer list are shown alone (no pair).
 */
export function RedlineList({ banned, required, className }: RedlineListProps) {
  const max = Math.max(banned.length, required.length);
  if (max === 0) return null;
  return (
    <ul className={cn("space-y-2", className)}>
      {Array.from({ length: max }).map((_, i) => {
        const b = banned[i];
        const r = required[i];
        return (
          <li key={i} className="flex items-baseline gap-3 font-display text-[20px]">
            {b ? (
              <s className="text-ink-faint decoration-accent decoration-2">{b}</s>
            ) : (
              <span className="text-ink-faint italic">—</span>
            )}
            <span aria-hidden className="font-mono text-[14px] text-accent">→</span>
            {r ? (
              <em
                className="not-italic font-display text-ink"
                style={{ fontVariationSettings: '"opsz" 36' }}
              >
                {r}
              </em>
            ) : (
              <span className="text-ink-faint italic">—</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
