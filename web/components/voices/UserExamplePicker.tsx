"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, promptsApi } from "@/lib/api";

interface UserExamplePickerProps {
  agent: string;
  schemaHint: React.ReactNode;
}

export function UserExamplePicker({ agent, schemaHint }: UserExamplePickerProps) {
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.listRuns(),
  });
  const [runId, setRunId] = useState<string | null>(null);

  const example = useQuery({
    enabled: runId !== null,
    queryKey: ["user-example", runId, agent],
    queryFn: () => promptsApi.userExample(runId!, agent),
    retry: false,
  });

  return (
    <div className="space-y-3">
      {schemaHint}

      <div className="flex items-center gap-2">
        <label className="font-mono text-[10px] tracking-wider uppercase text-ink-faint">
          Load example from run
        </label>
        <select
          value={runId ?? ""}
          onChange={(e) => setRunId(e.target.value || null)}
          className="text-[12px] border border-rule bg-paper px-2 py-1 max-w-[280px]"
        >
          <option value="">— pick a run —</option>
          {runs.data?.map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {new Date(r.created_at).toISOString().slice(0, 10)} · {r.topic.slice(0, 40)}
            </option>
          ))}
        </select>
      </div>

      {example.isError && (
        <p className="text-accent-deep text-[12px]">
          {(example.error as Error).message}
        </p>
      )}
      {example.data && (
        <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-soft border border-rule p-3 max-h-[480px] overflow-auto">
          {example.data.prompt}
        </pre>
      )}
    </div>
  );
}
