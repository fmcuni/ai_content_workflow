import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionHeadProps {
  kicker?: ReactNode;
  hed: ReactNode;
  dek?: ReactNode;
  actions?: ReactNode;
  size?: "lg" | "md";
  className?: string;
}

export function SectionHead({ kicker, hed, dek, actions, size = "lg", className }: SectionHeadProps) {
  return (
    <header className={cn("flex items-end justify-between gap-6 mb-6", className)}>
      <div className="min-w-0 flex-1">
        {kicker ? <p className="kicker mb-2">{kicker}</p> : null}
        <h1
          className={cn(
            "hed",
            size === "lg" ? "text-[44px]" : "text-[28px]"
          )}
          style={{ fontVariationSettings: '"opsz" 144, "SOFT" 80' }}
        >
          {hed}
        </h1>
        {dek ? <p className="dek mt-3">{dek}</p> : null}
      </div>
      {actions ? <div className="shrink-0 pb-2">{actions}</div> : null}
    </header>
  );
}
