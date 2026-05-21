"use client";
import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { EventTimeline } from "@/components/EventTimeline";
import { CostMeter } from "@/components/CostMeter";
import { useRunEvents } from "@/lib/sse";
import { api } from "@/lib/api";

export default function RunDetail({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const { data: run } = useQuery({
    queryKey: ["run", runId], queryFn: () => api.getRun(runId),
    refetchInterval: 3000,
  });
  const events = useRunEvents(runId);

  return (
    <div className="max-w-4xl mx-auto p-8">
      <Link href="/" className="text-sm text-neutral-500">← All runs</Link>
      <h1 className="text-xl font-semibold mt-2 mb-1">{run?.topic ?? "…"}</h1>
      <p className="text-neutral-500 text-sm">{run?.article_url}</p>
      <div className="flex gap-3 mt-3 mb-2">
        {run && <RunStatusBadge status={run.status} />}
        {run?.chosen_route && <span className="text-sm">Route: <b>{run.chosen_route}</b></span>}
        {run && <span className="text-sm">Iteration: {run.iteration_count}</span>}
      </div>
      <div className="mb-6">
        <CostMeter runId={runId} />
      </div>
      <div className="grid grid-cols-2 gap-6">
        <Card className="p-4">
          <h2 className="font-medium mb-3">Live progress</h2>
          <EventTimeline events={events} />
        </Card>
        <Card className="p-4">
          <h2 className="font-medium mb-3">Actions</h2>
          {run?.status === "hitl_1" && (
            <Link href={`/runs/${runId}/hitl1`}><Button>Review gap analysis + outline</Button></Link>
          )}
          {run?.status === "hitl_2" && (
            <Link href={`/runs/${runId}/hitl2`}><Button>Review final draft</Button></Link>
          )}
        </Card>
      </div>
    </div>
  );
}
