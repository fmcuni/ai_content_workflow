"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";

import { AutoAcceptField } from "@/components/AutoAcceptField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionHead } from "@/components/SectionHead";
import { personasApi, topicBatchesApi } from "@/lib/api";
import type { TopicBatchIn } from "@/lib/types";
import { cn } from "@/lib/utils";

const DEFAULT_PERSONA = "bowtie-editor";
const DEFAULT_TOPIC_COUNT = 10;
const DEFAULT_KEYWORDS_PER_TOPIC = 5;

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function BriefForm() {
  const router = useRouter();

  const personasQ = useQuery({
    queryKey: ["personas-active"],
    queryFn: () => personasApi.list(false),
  });

  const [researchTheme, setResearchTheme] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [topicCount, setTopicCount] = useState(DEFAULT_TOPIC_COUNT);
  const [keywordsPerTopic, setKeywordsPerTopic] = useState(DEFAULT_KEYWORDS_PER_TOPIC);
  const [mustCover, setMustCover] = useState("");
  const [mustAvoid, setMustAvoid] = useState("");
  const [priorityFocus, setPriorityFocus] = useState("");
  const [notes, setNotes] = useState("");
  const [persona, setPersona] = useState(DEFAULT_PERSONA);
  const [acfAdvId, setAcfAdvId] = useState(0);
  const [acfWidgetId, setAcfWidgetId] = useState(0);
  const [autoAccept, setAutoAccept] = useState(false);

  const personas = personasQ.data ?? [];

  const fieldError = useMemo(() => {
    if (!researchTheme.trim()) return "Research theme is required.";
    if (!targetAudience.trim()) return "Target audience is required.";
    if (topicCount < 1 || topicCount > 30) return "# of topics must be between 1 and 30.";
    if (keywordsPerTopic < 1 || keywordsPerTopic > 10)
      return "# of keywords per topic must be between 1 and 10.";
    return null;
  }, [researchTheme, targetAudience, topicCount, keywordsPerTopic]);

  const submitMut = useMutation({
    mutationFn: async () => {
      const payload: TopicBatchIn = {
        research_theme: researchTheme.trim(),
        target_audience: targetAudience.trim(),
        topic_count: topicCount,
        keywords_per_topic: keywordsPerTopic,
        must_cover: splitLines(mustCover),
        must_avoid: splitLines(mustAvoid),
        priority_focus: priorityFocus.trim() || null,
        notes: notes.trim() || null,
        persona_default: persona || DEFAULT_PERSONA,
        acf_adv_id_default: acfAdvId,
        acf_widget_id_default: acfWidgetId,
        auto_accept_hitl1_default: autoAccept,
        editor_email: "",
      };
      return topicBatchesApi.create(payload);
    },
    onSuccess: (res) => {
      router.push(`/topic-batches/${res.batch_id}`);
    },
  });

  return (
    <section aria-labelledby="brief-title" className="space-y-8">
      <div className="border-b border-ink pb-3">
        <SectionHead
          kicker="Front II · Commissioning Brief"
          hed="Open the Story Budget"
          dek="Brief the desk on a research theme. The wire returns a vetted batch of topic candidates for the meeting."
        />
      </div>

      <form
        className="mx-auto max-w-[760px] space-y-7"
        onSubmit={(e) => {
          e.preventDefault();
          if (fieldError) return;
          submitMut.mutate();
        }}
      >
        <BriefField label="Research theme" required hint="One-line frame for the batch.">
          <Input
            value={researchTheme}
            onChange={(e) => setResearchTheme(e.target.value)}
            autoFocus
          />
        </BriefField>

        <BriefField label="Target audience" required hint="Who the topics speak to.">
          <Input
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
          />
        </BriefField>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <BriefField label="# of topics" hint="1–30. Default 10.">
            <Input
              type="number"
              min={1}
              max={30}
              value={topicCount}
              onChange={(e) =>
                setTopicCount(parseInt(e.target.value || String(DEFAULT_TOPIC_COUNT), 10))
              }
              className="font-mono tabular-nums"
            />
          </BriefField>

          <BriefField label="# of keywords per topic" hint="1–10. Default 5.">
            <Input
              type="number"
              min={1}
              max={10}
              value={keywordsPerTopic}
              onChange={(e) =>
                setKeywordsPerTopic(
                  parseInt(e.target.value || String(DEFAULT_KEYWORDS_PER_TOPIC), 10),
                )
              }
              className="font-mono tabular-nums"
            />
          </BriefField>
        </div>

        <BriefField label="Must cover" hint="One angle per line. Optional.">
          <Textarea
            value={mustCover}
            onChange={(e) => setMustCover(e.target.value)}
            rows={3}
          />
        </BriefField>

        <BriefField label="Must avoid" hint="One angle per line. Optional.">
          <Textarea
            value={mustAvoid}
            onChange={(e) => setMustAvoid(e.target.value)}
            rows={3}
          />
        </BriefField>

        <BriefField label="Priority focus" hint="What weighs heavier in the cut. Optional.">
          <Textarea
            value={priorityFocus}
            onChange={(e) => setPriorityFocus(e.target.value)}
            rows={2}
          />
        </BriefField>

        <BriefField label="Notes" hint="Stage directions for the desk. Optional.">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </BriefField>

        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_120px_120px] gap-6">
          <BriefField label="Voice" hint="Applied to every promoted candidate; editable at HITL_T1.">
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              disabled={personasQ.isLoading}
              className={cn(
                "h-9 w-full bg-transparent text-[13px] text-ink border-0 border-b border-rule rounded-none px-0 py-1.5 outline-none",
                "focus-visible:border-b-2 focus-visible:border-accent appearance-none cursor-pointer",
              )}
            >
              {personasQ.isLoading && <option>Loading voices…</option>}
              {!personasQ.isLoading && personas.length === 0 && (
                <option value={DEFAULT_PERSONA}>{DEFAULT_PERSONA}</option>
              )}
              {personas.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
              {!personasQ.isLoading &&
                personas.length > 0 &&
                !personas.some((p) => p.slug === persona) && (
                  <option value={persona}>{persona} (unknown)</option>
                )}
            </select>
          </BriefField>

          <BriefField label="ADV" hint="acf_adv_id">
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={acfAdvId === 0 ? "" : acfAdvId}
              onChange={(e) => setAcfAdvId(parseInt(e.target.value.replace(/\D/g, "") || "0", 10))}
              className="font-mono text-[12px] tabular-nums"
              aria-label="acf_adv_id"
            />
          </BriefField>

          <BriefField label="Widget" hint="acf_widget_id">
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={acfWidgetId === 0 ? "" : acfWidgetId}
              onChange={(e) =>
                setAcfWidgetId(parseInt(e.target.value.replace(/\D/g, "") || "0", 10))
              }
              className="font-mono text-[12px] tabular-nums"
              aria-label="acf_widget_id"
            />
          </BriefField>
        </div>

        <AutoAcceptField
          checked={autoAccept}
          onChange={setAutoAccept}
          hint="Every run promoted from this batch auto-approves its HITL_1 outline / gap-analysis review and goes straight to drafting. Each draft still stops at HITL_2 before publishing. You can still flip it per run later."
        />

        <div className="flex items-center justify-between gap-4 pt-3 border-t border-rule">
          <Link href="/" className="text-[12px] text-ink-soft hover:text-ink">
            ↩ Back to the desk
          </Link>
          <div className="flex items-center gap-4">
            {fieldError && !submitMut.isPending && (
              <p className="text-accent-deep text-[12px] font-mono">{fieldError}</p>
            )}
            {submitMut.isError && (
              <p className="text-accent-deep text-[12px] font-mono">
                {(submitMut.error as Error).message}
              </p>
            )}
            <Button
              type="submit"
              size="lg"
              disabled={submitMut.isPending || !!fieldError}
            >
              {submitMut.isPending ? "Opening the budget…" : "Open the budget →"}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

function BriefField({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="kicker">
          {label}
          {required && <span className="text-accent-deep"> *</span>}
        </span>
        {hint && (
          <span className="font-mono text-[10.5px] text-ink-faint tracking-wide">{hint}</span>
        )}
      </span>
      {children}
    </label>
  );
}
