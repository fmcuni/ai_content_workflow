"use client";

import Link from "next/link";

interface StudioEntryBandProps {
  /** The currently selected voice slug from the Rolodex, or null if none. */
  slug: string | null;
}

/**
 * Editorial entry band for Voice Studio. Sits between the Rolodex and the Style
 * Card and turns the previously-buried "Open in Studio" affordance into the
 * page's primary call to action, reflecting the Rolodex selection. Purely
 * presentational — no data fetching.
 */
export function StudioEntryBand({ slug }: StudioEntryBandProps) {
  const hasVoice = slug !== null && slug.length > 0;

  return (
    <section
      aria-label="voice-studio-entry"
      className="flex flex-col gap-4 border border-rule bg-paper-deep/30 px-5 py-5 md:flex-row md:items-center md:justify-between md:gap-8 md:px-7 md:py-6"
    >
      <div className="min-w-0">
        <p className="kicker mb-1.5">Voice Studio</p>
        <p className="max-w-[58ch] text-[15px] leading-relaxed text-ink-soft">
          Map the full pipeline a story walks — tune prompts, partials, locale and
          glossary for this voice in one canvas.
        </p>
      </div>

      <div className="shrink-0">
        {hasVoice ? (
          <Link
            href={`/voices/${encodeURIComponent(slug)}`}
            className="inline-flex items-center gap-2 rounded-sm bg-ink px-4 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-paper transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            ⬡ Open {slug} in Studio →
          </Link>
        ) : (
          <div className="flex flex-col items-start gap-1 md:items-end">
            <button
              type="button"
              disabled
              className="inline-flex cursor-not-allowed items-center gap-2 rounded-sm border border-rule px-4 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-ink-faint"
            >
              ⬡ Open in Studio →
            </button>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              Select a voice above
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
