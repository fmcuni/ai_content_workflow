"use client";

import type { GapAnalysis } from "@/lib/types";

function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">{title}</h4>
      {children}
    </div>
  );
}

function TextSec({ title, value }: { title: string; value?: string | null }) {
  if (!value) return null;
  return (
    <Sec title={title}>
      <p className="text-[12.5px] leading-relaxed text-ink">{value}</p>
    </Sec>
  );
}

function ListSec({ title, items }: { title: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <Sec title={title}>
      <ul className="ml-4 list-disc text-[12px] leading-relaxed text-ink">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </Sec>
  );
}

function ChipSec({ title, items }: { title: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <Sec title={title}>
      <div className="flex flex-wrap gap-1">
        {items.map((x, i) => (
          <span key={i} className="rounded bg-paper-deep px-1.5 py-px text-[11px] text-ink-soft">
            {x}
          </span>
        ))}
      </div>
    </Sec>
  );
}

/**
 * Outlined-mode middle column (spec §4.5): the gap analysis. Create-mode runs
 * skip gap analysis entirely, so we show the explanatory empty state instead.
 */
export function GapPanel({ gap, createMode }: { gap: GapAnalysis | null; createMode: boolean }) {
  if (createMode) {
    return (
      <p className="py-3.5 text-[12.5px] italic text-ink-faint">
        No gap analysis — this is a new article (create mode), so the pipeline skipped it.
      </p>
    );
  }
  if (!gap) {
    return <p className="py-3.5 text-[12.5px] italic text-ink-faint">No gap analysis available.</p>;
  }

  const assess = gap.current_article_assessment;
  const gaps = gap.content_gaps;
  const plan = gap.update_plan;

  return (
    <div>
      <TextSec title="Target query" value={gap.target_query} />
      {(gap.chosen_route || gap.route_reason) && (
        <Sec title="Route">
          <p className="text-[12.5px] leading-relaxed text-ink">
            <span className="font-semibold">{gap.chosen_route}</span>
            {gap.route_reason ? ` — ${gap.route_reason}` : ""}
          </p>
        </Sec>
      )}
      <ListSec title="Weak sections" items={assess?.weak_sections} />
      <ListSec title="Outdated points" items={assess?.outdated_points} />
      <ListSec title="Missing topics" items={gaps?.missing_topics} />
      <ListSec title="FAQ gaps" items={gaps?.faq_gaps} />
      <ChipSec title="Semantic gaps" items={gaps?.semantic_gaps} />
      <ListSec title="Freshness" items={gaps?.freshness_gaps} />
      <ListSec title="Must add" items={plan?.must_add} />
      <ListSec title="Must update" items={plan?.must_update} />
      <ListSec title="Must remove" items={plan?.must_remove} />
      {gap.top_pages && gap.top_pages.length > 0 && (
        <Sec title="Top competing pages">
          <ul className="ml-4 list-disc text-[12px] leading-relaxed">
            {gap.top_pages.slice(0, 5).map((p, i) => (
              <li key={i}>
                <a href={p.url} target="_blank" rel="noreferrer" className="text-info hover:underline">
                  {p.title || p.url}
                </a>
              </li>
            ))}
          </ul>
        </Sec>
      )}
    </div>
  );
}
