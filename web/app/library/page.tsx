"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { refreshApi } from "@/lib/api";
import { LibraryTable } from "@/components/LibraryTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function LibraryPage() {
  const [needsRefresh, setNeedsRefresh] = useState<boolean | undefined>(
    undefined
  );
  const [persona, setPersona] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<
    "staleness" | "next_scan_due" | "last_persisted" | ""
  >("");

  const scanMutation = useMutation({
    mutationFn: () => refreshApi.scanAll(),
    onSuccess: (r) =>
      toast.success(
        `Scan complete — ${r.evaluations_created} evaluations created`
      ),
    onError: (e: Error) => toast.error(e.message),
  });

  const filters = {
    needs_refresh: needsRefresh,
    persona: persona || undefined,
    q: q || undefined,
    sort: sort || undefined,
  } as {
    needs_refresh?: boolean;
    persona?: string;
    q?: string;
    sort?: "staleness" | "next_scan_due" | "last_persisted";
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Article Library</h1>
        <Button
          onClick={() => scanMutation.mutate()}
          disabled={scanMutation.isPending}
        >
          {scanMutation.isPending ? "Scanning…" : "Run scan now"}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        {/* needs_refresh toggle */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Status</label>
          <Select
            value={
              needsRefresh === undefined
                ? "all"
                : needsRefresh
                ? "needs_refresh"
                : "ok"
            }
            onValueChange={(v) => {
              if (v === "all") setNeedsRefresh(undefined);
              else if (v === "needs_refresh") setNeedsRefresh(true);
              else setNeedsRefresh(false);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="needs_refresh">Needs refresh</SelectItem>
              <SelectItem value="ok">OK</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* persona */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Persona</label>
          <Input
            className="w-40"
            placeholder="e.g. bowtie-editor"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
          />
        </div>

        {/* search */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Search</label>
          <Input
            className="w-60"
            placeholder="Topic or URL…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {/* sort */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Sort</label>
          <Select
            value={sort || "staleness"}
            onValueChange={(v) =>
              setSort(
                v as "staleness" | "next_scan_due" | "last_persisted" | ""
              )
            }
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Sort by…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="staleness">Staleness</SelectItem>
              <SelectItem value="next_scan_due">Next scan due</SelectItem>
              <SelectItem value="last_persisted">Last persisted</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <LibraryTable filters={filters} />
    </div>
  );
}
