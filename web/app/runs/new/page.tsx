"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RefreshFindingsPanel } from "@/components/RefreshFindingsPanel";
import { api, articlesApi, refreshApi } from "@/lib/api";
import type { CreateRunRequest } from "@/lib/types";

const DEFAULT_FORM: CreateRunRequest = {
  article_url: "", topic: "", keywords: [],
  mode: "auto", edit_note: null,
  acf_adv_id: 1, acf_widget_id: 1,
  persona: "bowtie-editor", topic_category: null,
  editor_email: process.env.NEXT_PUBLIC_DEFAULT_EDITOR_EMAIL ?? "",
  triggered_by_evaluation_id: null,
};

export default function NewRunPage() {
  const router = useRouter();
  const params = useSearchParams();
  const articleId = params.get("article_id");
  const evaluationId = params.get("evaluation_id");

  const [form, setForm] = useState<CreateRunRequest>(DEFAULT_FORM);
  const [keywordsRaw, setKeywordsRaw] = useState("");
  const seeded = useRef(false);

  const { data: article } = useQuery({
    queryKey: ["article", articleId],
    queryFn: () => articleId ? articlesApi.detail(articleId) : Promise.resolve(null),
    enabled: !!articleId,
  });

  const { data: evaluation } = useQuery({
    queryKey: ["evaluation", evaluationId],
    queryFn: () => evaluationId ? refreshApi.getEvaluation(evaluationId) : Promise.resolve(null),
    enabled: !!evaluationId,
  });

  // Prefill form once when remote data arrives. Both queries must settle (or not be requested)
  // before we seed, so the mode + article fields are applied together.
  const articleReady = !articleId || article !== undefined;
  const evaluationReady = !evaluationId || evaluation !== undefined;
  useEffect(() => {
    if (seeded.current) return;
    if (!articleReady || !evaluationReady) return;
    if (!article && !evaluation) return;
    seeded.current = true;
    const next = { ...DEFAULT_FORM };
    if (article) {
      next.article_url = article.article_url;
      next.persona = article.persona ?? DEFAULT_FORM.persona;
      next.topic = article.topic ?? DEFAULT_FORM.topic;
      next.topic_category = article.topic_category ?? DEFAULT_FORM.topic_category;
    }
    if (evaluation) {
      next.mode = evaluation.deterministic_findings.severity_high > 0
        ? "full_rewrite"
        : "small_refresh";
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(next);
  }, [articleReady, evaluationReady, article, evaluation]);

  const mutation = useMutation({
    mutationFn: () => api.createRun({
      ...form,
      keywords: keywordsRaw.split(",").map(s => s.trim()).filter(Boolean),
      triggered_by_evaluation_id: evaluationId ?? undefined,
    }),
    onSuccess: (r) => router.push(`/runs/${r.run_id}`),
  });

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-xl font-semibold mb-4">New article update</h1>

      {evaluation && (
        <div className="mb-6">
          <h2 className="text-sm font-medium mb-2">Refresh context</h2>
          <RefreshFindingsPanel ev={evaluation} />
        </div>
      )}

      <Card className="p-6 space-y-4">
        <div>
          <Label>Article URL</Label>
          <Input value={form.article_url} onChange={(e) => setForm({ ...form, article_url: e.target.value })}
                 placeholder="https://www.bowtie.com.hk/blog/zh/..." />
        </div>
        <div>
          <Label>Topic</Label>
          <Input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} />
        </div>
        <div>
          <Label>Focus keywords (comma-separated)</Label>
          <Input value={keywordsRaw} onChange={(e) => setKeywordsRaw(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Mode</Label>
            <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as CreateRunRequest["mode"] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="small_refresh">Small refresh</SelectItem>
                <SelectItem value="full_rewrite">Full rewrite</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Persona</Label>
            <Input value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>acf_adv_id</Label>
            <Input type="number" value={form.acf_adv_id}
                   onChange={(e) => setForm({ ...form, acf_adv_id: parseInt(e.target.value || "0", 10) })} />
          </div>
          <div>
            <Label>acf_widget_id</Label>
            <Input type="number" value={form.acf_widget_id}
                   onChange={(e) => setForm({ ...form, acf_widget_id: parseInt(e.target.value || "0", 10) })} />
          </div>
        </div>
        <div>
          <Label>Topic category (optional, for community sources)</Label>
          <Input value={form.topic_category ?? ""} onChange={(e) => setForm({ ...form, topic_category: e.target.value || null })}
                 placeholder="community-response / patient-experience / social-discussion" />
        </div>
        <div>
          <Label>Edit note (optional)</Label>
          <Textarea value={form.edit_note ?? ""} onChange={(e) => setForm({ ...form, edit_note: e.target.value || null })} />
        </div>
        <div>
          <Label>Editor email</Label>
          <Input value={form.editor_email} onChange={(e) => setForm({ ...form, editor_email: e.target.value })} />
        </div>
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Start run"}
        </Button>
        {mutation.isError && <p className="text-rose-600">{(mutation.error as Error).message}</p>}
      </Card>
    </div>
  );
}
