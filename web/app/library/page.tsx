"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { refreshApi } from "@/lib/api";
import { LibraryTable } from "@/components/LibraryTable";
import { SectionHead } from "@/components/SectionHead";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function LibraryPage() {
  const [needsRefresh, setNeedsRefresh] = useState<boolean | undefined>(undefined);
  const [persona, setPersona] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"staleness" | "next_scan_due" | "last_persisted" | "">("");

  const scanMutation = useMutation({
    mutationFn: () => refreshApi.scanAll(),
    onSuccess: (r) => toast.success(`Scan complete — ${r.evaluations_created} evaluations created`),
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
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 space-y-8">
      <SectionHead
        kicker="Archive"
        hed="Article Library"
        dek="Every article we monitor, with the desk's latest evaluation. Re-scanned on the schedule and on demand."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
          >
            {scanMutation.isPending ? "Scanning…" : "Run scan now"}
          </Button>
        }
      />

      <div className="border-y border-rule py-4 grid grid-cols-1 md:grid-cols-4 gap-x-8 gap-y-4">
        <ToolbarField label="Status">
          <Select
            value={needsRefresh === undefined ? "all" : needsRefresh ? "needs_refresh" : "ok"}
            onValueChange={(v) => {
              if (v === "all") setNeedsRefresh(undefined);
              else if (v === "needs_refresh") setNeedsRefresh(true);
              else setNeedsRefresh(false);
            }}
          >
            <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="needs_refresh">Needs refresh</SelectItem>
              <SelectItem value="ok">OK</SelectItem>
            </SelectContent>
          </Select>
        </ToolbarField>

        <ToolbarField label="Persona">
          <Input placeholder="e.g. bowtie-editor" value={persona} onChange={(e) => setPersona(e.target.value)} />
        </ToolbarField>

        <ToolbarField label="Search">
          <Input placeholder="Topic or URL…" value={q} onChange={(e) => setQ(e.target.value)} />
        </ToolbarField>

        <ToolbarField label="Sort">
          <Select value={sort || "staleness"} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger><SelectValue placeholder="Sort by…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="staleness">Staleness</SelectItem>
              <SelectItem value="next_scan_due">Next scan due</SelectItem>
              <SelectItem value="last_persisted">Last persisted</SelectItem>
            </SelectContent>
          </Select>
        </ToolbarField>
      </div>

      <LibraryTable filters={filters} />
    </div>
  );
}

function ToolbarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="kicker">{label}</label>
      {children}
    </div>
  );
}
