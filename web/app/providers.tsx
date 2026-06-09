"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { IdleWatchdog } from "@/components/IdleWatchdog";

import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={qc}>
      {children}
      <IdleWatchdog />
      <Toaster />
    </QueryClientProvider>
  );
}
