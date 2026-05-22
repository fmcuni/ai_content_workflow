"use client";
import { useQuery } from "@tanstack/react-query";

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

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
  const totalTokens = data.tokens_in + data.tokens_out + data.thinking_tokens;
  // HK$ at 7.8 ~= USD; we show as HK$ since this is Bowtie/HK.
  const hk = (data.est_usd_cents / 100) * 7.8;
  return (
    <span className="font-mono text-[12px] text-ink-soft tabular-nums">
      HK$ {hk.toFixed(2)} · {formatTokens(totalTokens)} tok
    </span>
  );
}
