import { cn } from "@/lib/utils";
import type { RecommendedAction } from "@/lib/types";

interface StalenessIndicatorProps {
  score: string;
  recommendedAction: RecommendedAction;
  className?: string;
}

const DOT_COUNT = 4;

function scoreToDots(score: string): number {
  const n = Number(score);
  if (n >= 8) return 4;
  if (n >= 6) return 3;
  if (n >= 3) return 2;
  if (n > 0) return 1;
  return 0;
}

function actionColor(action: RecommendedAction): string {
  if (action === "refresh") return "bg-red-500";
  if (action === "monitor") return "bg-yellow-400";
  return "bg-green-500";
}

export function StalenessIndicator({
  score,
  recommendedAction,
  className,
}: StalenessIndicatorProps) {
  const filled = scoreToDots(score);
  const color = actionColor(recommendedAction);

  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={`Staleness score: ${Number(score).toFixed(1)}`}
    >
      <span className="text-xs font-mono tabular-nums text-muted-foreground w-8 text-right">
        {Number(score).toFixed(1)}
      </span>
      <span className="inline-flex gap-0.5">
        {Array.from({ length: DOT_COUNT }, (_, i) => (
          <span
            key={i}
            className={cn(
              "inline-block h-2 w-2 rounded-full transition-colors",
              i < filled ? color : "bg-muted"
            )}
          />
        ))}
      </span>
    </span>
  );
}
