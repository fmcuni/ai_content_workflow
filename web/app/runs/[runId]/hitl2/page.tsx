"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionHead } from "@/components/SectionHead";
import { PaperStamp } from "@/components/PaperStamp";
import { TipTapEditor } from "@/components/TipTapEditor";
import { HtmlDiffView } from "@/components/HtmlDiffView";
import { WordPressMetaForm } from "@/components/WordPressMetaForm";
import { api } from "@/lib/api";
import type { Hitl2Request } from "@/lib/types";

export default function Hitl2Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();

  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });
  const audit = useQuery({ queryKey: ["audit", runId], queryFn: () => api.getLatestAudit(runId) });

  const [html, setHtml] = useState<string>("");
  const [form, setForm] = useState<Hitl2Request>({ decision: "approve", wp_publish_status: "draft" });
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
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 pb-32">
      <div className="mb-4">
        <Link href={`/runs/${runId}`} className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider">
          ← Run · {shortId}
        </Link>
      </div>

      <SectionHead
        kicker={<>Galley Proof · Stage 2 · <span className="text-accent">{shortId}</span></>}
        hed="Editor's review"
        dek="Final pass on the draft. Approve and push to WordPress as draft, request changes, or reject."
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
        {/* Galley column */}
        <section>
          <Tabs defaultValue="edit">
            <TabsList className="border-b border-rule">
              <TabsTrigger value="edit">Edit</TabsTrigger>
              <TabsTrigger value="diff">Diff vs render</TabsTrigger>
              <TabsTrigger value="audit">Audit findings</TabsTrigger>
            </TabsList>
            <TabsContent value="edit" className="pt-6">
              <div className="max-w-[65ch] mx-auto font-display text-[18px] leading-[1.65] text-ink" style={{ fontVariationSettings: '"opsz" 14, "SOFT" 60' }}>
                <TipTapEditor value={html} onChange={setHtml} />
              </div>
            </TabsContent>
            <TabsContent value="diff" className="pt-6">
              <HtmlDiffView original={originalHtml} updated={html} />
            </TabsContent>
            <TabsContent value="audit" className="pt-6">
              {audit.data && (
                <div className="space-y-3 text-[13px]">
                  <p className="font-mono text-[12px]">
                    OVERALL · <span className={audit.data.overall_pass ? "text-ok" : "text-accent-deep"}>{audit.data.overall_pass ? "PASS ✓" : "FAIL ✗"}</span>
                    {"  "}·  HIGH <span className="tabular-nums">{audit.data.severity_high}</span>
                    {"  "}·  MED <span className="tabular-nums">{audit.data.severity_medium}</span>
                    {"  "}·  LOW <span className="tabular-nums">{audit.data.severity_low}</span>
                  </p>
                  <ol className="space-y-3">
                    {[...audit.data.llm_findings.findings, ...audit.data.deterministic_findings.findings].map((f) => (
                      <li key={f.id} className="border-l-2 border-rule pl-4 py-1">
                        <div className="flex items-center gap-2 mb-1">
                          <PaperStamp tone={f.severity === "high" ? "danger" : f.severity === "medium" ? "warn" : "neutral"}>{f.severity}</PaperStamp>
                          <span className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">{f.category} · {f.location}</span>
                        </div>
                        <p className="text-ink">{f.issue}</p>
                        <p className="text-ink-soft text-[12px] mt-1">→ {f.suggested_fix}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </section>

        {/* WP metadata column */}
        <aside className="lg:sticky lg:top-32 self-start">
          <p className="kicker mb-3">WordPress metadata</p>
          <Card variant="editorial" className="px-5 py-5">
            <WordPressMetaForm form={form} onChange={setForm} />
          </Card>
        </aside>
      </div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 bg-paper/95 backdrop-blur border-t border-ink z-40">
        <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-3 flex items-center justify-end gap-2">
          <Button variant="destructive" size="sm" disabled={submit.isPending} onClick={() => submit.mutate("reject")}>Reject ✕</Button>
          <Button variant="secondary" size="sm" disabled={submit.isPending} onClick={() => submit.mutate("request_changes")}>Request changes ↺</Button>
          <Button variant="primary" disabled={submit.isPending} onClick={() => submit.mutate("approve")}>
            {submit.isPending ? "Pushing…" : "Approve & push to WP ↪"}
          </Button>
        </div>
      </div>
    </div>
  );
}
