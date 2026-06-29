interface Props {
  /** The highlighted span text this annotation is anchored to. */
  text: string | null;
  /** Extra classes (e.g. spacing) from the caller. */
  className?: string;
}

/**
 * The "…anchor text…" kicker shared by every annotated card (AI-edit comments,
 * review threads, the pending-note composer). One canonical class order so the
 * three surfaces can't drift apart again.
 */
export function AnchorQuote({ text, className = "" }: Props) {
  return (
    <p
      className={`line-clamp-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint ${className}`}
    >
      &ldquo;{text}&rdquo;
    </p>
  );
}
