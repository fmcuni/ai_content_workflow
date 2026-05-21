"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TipTapEditor } from "@/components/TipTapEditor";
import { HtmlDiffView } from "@/components/HtmlDiffView";
import { WordPressMetaForm } from "@/components/WordPressMetaForm";
import { api } from "@/lib/api";
import type { Hitl2Request } from "@/lib/types";

export default function Hitl2Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const router = useRouter();

  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });
  const audit = useQuery({ queryKey: ["audit", runId], queryFn: () => api.getLatestAudit(runId) });

  const [html, setHtml] = useState<string>("");
  const [form, setForm] = useState<Hitl2Request>({
    decision: "approve", wp_publish_status: "draft",
  });
  const [originalHtml, setOriginalHtml] = useState("");

  useEffect(() => {
    if (render.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHtml(render.data.html_body);
      setOriginalHtml(render.data.html_body);
      setForm((f) => ({
        ...f,
        edited_seo_title: render.data!.seo_title,
        edited_meta_description: render.data!.meta_description,
        wp_excerpt: render.data!.excerpt_suggestion,
      }));
    }
  }, [render.data]);

  const submit = useMutation({
    mutationFn: (decision: Hitl2Request["decision"]) =>
      api.resumeHitl2(runId, { ...form, decision, edited_html_body: html }),
    onSuccess: () => router.push(`/runs/${runId}`),
  });

  return (
    <div className="max-w-7xl mx-auto p-8 grid grid-cols-3 gap-6">
      <Card className="p-4 col-span-2">
        <Tabs defaultValue="edit">
          <TabsList>
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="diff">Diff vs render</TabsTrigger>
            <TabsTrigger value="audit">Audit findings</TabsTrigger>
          </TabsList>
          <TabsContent value="edit"><TipTapEditor value={html} onChange={setHtml} /></TabsContent>
          <TabsContent value="diff"><HtmlDiffView original={originalHtml} updated={html} /></TabsContent>
          <TabsContent value="audit">
            {audit.data && (
              <div className="space-y-2 text-sm">
                <p><b>Overall pass:</b> {audit.data.overall_pass ? "✓" : "✗"}</p>
                <p>High: {audit.data.severity_high} · Medium: {audit.data.severity_medium} · Low: {audit.data.severity_low}</p>
                <ul className="space-y-2 mt-2">
                  {[...audit.data.llm_findings.findings, ...audit.data.deterministic_findings.findings].map((f) => (
                    <li key={f.id} className="border p-2 rounded">
                      <p className="font-medium">[{f.severity}] {f.category} — {f.location}</p>
                      <p className="text-neutral-700">{f.issue}</p>
                      <p className="text-neutral-500 text-xs">→ {f.suggested_fix}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </Card>
      <Card className="p-4">
        <h2 className="font-medium mb-3">WordPress metadata</h2>
        <WordPressMetaForm form={form} onChange={setForm} />
        <div className="flex flex-col gap-2 mt-4">
          <Button onClick={() => submit.mutate("approve")} disabled={submit.isPending}>
            Approve → push to WP as Draft
          </Button>
          <Button variant="outline" onClick={() => submit.mutate("request_changes")}>Request changes</Button>
          <Button variant="destructive" onClick={() => submit.mutate("reject")}>Reject</Button>
        </div>
      </Card>
    </div>
  );
}
