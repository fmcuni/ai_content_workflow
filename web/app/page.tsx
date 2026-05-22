"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { RunStatusBadge } from "@/components/RunStatusBadge";
import { SectionHead } from "@/components/SectionHead";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function ledgerDate(iso: string) {
  const d = new Date(iso);
  return {
    day: DAYS[d.getDay()],
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

export default function Home() {
  const { data, isLoading } = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns() });

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <SectionHead
        kicker="Runs · Live"
        hed="Front Page"
        dek="Articles currently in motion through the desk."
        actions={
          <Link href="/runs/new">
            <Button variant="secondary" size="sm">Start a new run →</Button>
          </Link>
        }
      />

      {isLoading && <p className="text-ink-faint">Loading…</p>}

      {data && data.length === 0 && (
        <p className="font-display italic text-ink-faint text-[18px] mt-12">No stories on the wire.</p>
      )}

      <ul className="border-t border-rule">
        {data?.map((r) => {
          const { day, time } = ledgerDate(r.created_at);
          return (
            <li key={r.run_id} className="border-b border-rule group">
              <Link
                href={`/runs/${r.run_id}`}
                className={cn(
                  "grid grid-cols-[96px_1fr_220px] gap-6 py-5 items-center",
                  "transition-colors hover:bg-paper-deep/60"
                )}
              >
                <div className="text-left">
                  <p className="font-mono text-[11px] text-ink-faint tracking-wider group-hover:text-accent transition-colors">{day}</p>
                  <p className="font-mono text-[14px] text-ink-soft tabular-nums">{time}</p>
                </div>
                <div className="min-w-0">
                  <p className="font-display text-[22px] leading-tight text-ink truncate" style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}>
                    {r.topic}
                  </p>
                  <div className="mt-2 h-px bg-rule" />
                  <p className="mt-2 font-sans text-[12px] text-ink-faint truncate">{r.article_url}</p>
                </div>
                <div className="flex items-center justify-end gap-3">
                  <RunStatusBadge status={r.status} />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
