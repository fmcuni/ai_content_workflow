"use client";
import { useQuery } from "@tanstack/react-query";

export function CostMeter({ runId }: { runId: string }) {
  const { data } = useQuery({
    queryKey: ["cost", runId],
    queryFn: async () => {
      const r = await fetch(`/api/costs/run/${runId}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      return (await r.json()) as {
        tokens_in: number;
        tokens_out: number;
        thinking_tokens: number;
        est_usd_cents: number;
      };
    },
    refetchInterval: 5000,
  });
  if (!data) return null;
  return (
    <div className="text-xs text-neutral-500">
      Tokens: {data.tokens_in.toLocaleString()} in / {data.tokens_out.toLocaleString()} out
      {" · "}
      {data.thinking_tokens.toLocaleString()} thinking
      {" · "}
      Est: US${(data.est_usd_cents / 100).toFixed(2)}
    </div>
  );
}
