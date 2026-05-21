"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GapAnalysisView } from "@/components/GapAnalysisView";
import { OutlineEditor } from "@/components/OutlineEditor";
import { api } from "@/lib/api";
import type { Outline } from "@/lib/types";

export default function Hitl1Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const router = useRouter();
  const ga = useQuery({ queryKey: ["ga", runId], queryFn: () => api.getGapAnalysis(runId) });
  const ol = useQuery({ queryKey: ["outline", runId], queryFn: () => api.getOutline(runId) });
  const [edited, setEdited] = useState<Outline | null>(null);

  const approve = useMutation({
    mutationFn: () => api.resumeHitl1(runId, edited ? { decision: "edit_outline", edited_outline: edited } : { decision: "approve" }),
    onSuccess: () => router.push(`/runs/${runId}`),
  });
  const overrideRoute = useMutation({
    mutationFn: (newRoute: "small_refresh" | "full_rewrite") =>
      api.resumeHitl1(runId, { decision: "override_route", new_route: newRoute }),
    onSuccess: () => router.push(`/runs/${runId}`),
  });

  const outline = edited ?? ol.data?.payload ?? null;

  return (
    <div className="max-w-6xl mx-auto p-8 grid grid-cols-2 gap-6">
      <Card className="p-4">
        <h2 className="font-medium mb-3">Gap analysis</h2>
        {ga.data && <GapAnalysisView ga={ga.data} />}
      </Card>
      <Card className="p-4">
        <h2 className="font-medium mb-3">Outline (editable)</h2>
        {outline && <OutlineEditor outline={outline} onChange={setEdited} />}
        <div className="flex gap-2 mt-4">
          <Button onClick={() => approve.mutate()}>
            {edited ? "Approve with edits" : "Approve"}
          </Button>
          <Button variant="outline" onClick={() => overrideRoute.mutate("small_refresh")}>Force small_refresh</Button>
          <Button variant="outline" onClick={() => overrideRoute.mutate("full_rewrite")}>Force full_rewrite</Button>
        </div>
      </Card>
    </div>
  );
}
