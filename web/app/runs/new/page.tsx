"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SectionHead } from "@/components/SectionHead";
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="kicker">{label}</label>
      {children}
    </div>
  );
}

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
    <div className="mx-auto max-w-[760px] px-5 md:px-10 py-10 space-y-8">
      <SectionHead
        kicker="New Run"
        hed="Article Assignment"
        dek="Brief the desk on the next refresh."
        size="md"
      />

      {evaluation && (
        <RefreshFindingsPanel ev={evaluation} />
      )}

      {article && !evaluation && (
        <blockquote className="border-l-2 border-accent pl-5 space-y-2 text-[13px]">
          <p className="kicker">Brief from Archive</p>
          <p className="font-display text-[18px] text-ink leading-snug">{article.topic ?? "(no topic)"}</p>
          <a href={article.article_url} target="_blank" rel="noopener noreferrer"
             className="font-mono text-[11px] text-ink-faint underline-offset-2 hover:underline break-all line-clamp-1">
            {article.article_url}
          </a>
          <p className="font-mono text-[11px] text-ink-soft">
            OPEN RUNS · <span className="tabular-nums">{article.open_runs_count}</span>
            {article.last_persisted_at && <> · LAST PERSISTED {new Date(article.last_persisted_at).toLocaleDateString()}</>}
          </p>
        </blockquote>
      )}

      <Card variant="editorial" className="px-6 py-6 space-y-6">
        <Field label="Article URL">
          <Input value={form.article_url} onChange={(e) => setForm({ ...form, article_url: e.target.value })}
                 placeholder="https://www.bowtie.com.hk/blog/zh/..." />
        </Field>
        <Field label="Topic">
          <Input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} />
        </Field>
        <Field label="Focus keywords (comma-separated)">
          <Input value={keywordsRaw} onChange={(e) => setKeywordsRaw(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-6">
          <Field label="Mode">
            <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as CreateRunRequest["mode"] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="small_refresh">Small refresh</SelectItem>
                <SelectItem value="full_rewrite">Full rewrite</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Persona">
            <Input value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-6">
          <Field label="acf_adv_id">
            <Input type="number" value={form.acf_adv_id}
                   onChange={(e) => setForm({ ...form, acf_adv_id: parseInt(e.target.value || "0", 10) })} />
          </Field>
          <Field label="acf_widget_id">
            <Input type="number" value={form.acf_widget_id}
                   onChange={(e) => setForm({ ...form, acf_widget_id: parseInt(e.target.value || "0", 10) })} />
          </Field>
        </div>
        <Field label="Topic category (optional)">
          <Input value={form.topic_category ?? ""} onChange={(e) => setForm({ ...form, topic_category: e.target.value || null })}
                 placeholder="community-response / patient-experience / social-discussion" />
        </Field>
        <Field label="Edit note (optional)">
          <Textarea value={form.edit_note ?? ""} onChange={(e) => setForm({ ...form, edit_note: e.target.value || null })} />
        </Field>
        <Field label="Editor email">
          <Input value={form.editor_email} onChange={(e) => setForm({ ...form, editor_email: e.target.value })} />
        </Field>
        <div className="flex items-center justify-end gap-4 pt-2">
          <Link href="/" className="text-[12px] text-ink-soft hover:text-ink">Cancel ↩</Link>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Start run →"}
          </Button>
        </div>
        {mutation.isError && <p className="text-accent-deep text-[12px]">{(mutation.error as Error).message}</p>}
      </Card>
    </div>
  );
}
