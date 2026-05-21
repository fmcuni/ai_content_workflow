"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { api } from "@/lib/api";

export default function Home() {
  const { data, isLoading } = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns() });

  return (
    <div className="max-w-5xl mx-auto p-8">
      <header className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Bowtie AI Content Tool</h1>
        <Link href="/runs/new"><Button>New article update</Button></Link>
      </header>
      <Card className="divide-y">
        {isLoading && <p className="p-4">Loading…</p>}
        {data?.map((r) => (
          <Link key={r.run_id} href={`/runs/${r.run_id}`}
                className="p-4 flex justify-between hover:bg-neutral-50">
            <div>
              <p className="font-medium">{r.topic}</p>
              <p className="text-sm text-neutral-500">{r.article_url}</p>
            </div>
            <div className="flex items-center gap-3">
              <RunStatusBadge status={r.status} />
              <span className="text-xs text-neutral-500">{new Date(r.created_at).toLocaleString()}</span>
            </div>
          </Link>
        ))}
        {data?.length === 0 && <p className="p-4 text-neutral-500">No runs yet.</p>}
      </Card>
    </div>
  );
}
