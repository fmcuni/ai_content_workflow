"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { SectionHead } from "@/components/SectionHead";
import { SourcePolicyEditor } from "@/components/SourcePolicyEditor";
import { VoiceSelector } from "@/components/prompts/VoiceSelector";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { personasApi, promptsApi } from "@/lib/api";
import type { JudgeTemplateListItem, PromptTemplateListItem } from "@/lib/types";

const DEFAULT_VOICE = "bowtie-editor";
const SHARED_VOICE = "__shared__";

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Small badge on rows the voice inherits from the shared seed rather than
 * having customised — `voice_slug` resolves to `__shared__` for the fallback. */
function SharedBadge({ voiceSlug }: { voiceSlug: string }) {
  if (voiceSlug !== SHARED_VOICE) return null;
  return (
    <span className="ml-2 rounded border border-rule px-1 py-px font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
      shared default
    </span>
  );
}

function Section({
  title,
  hint,
  items,
  voice,
}: {
  title: string;
  hint: string;
  items: PromptTemplateListItem[];
  voice: string;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="kicker">
          {title} <span className="text-ink">· {items.length}</span>
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {hint}
        </span>
      </div>
      <ul className="border-t border-rule">
        {items.map((item) => (
          <li key={item.template_id} className="border-b border-rule">
            <Link
              href={`/prompts/${item.template_id}?voice=${encodeURIComponent(voice)}`}
              className="grid grid-cols-[1fr_auto] gap-4 py-4 items-center transition-colors hover:bg-paper-deep/60 group"
            >
              <div className="min-w-0">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  {item.category === "partial" ? "Partial" : "Agent prompt"}
                  <SharedBadge voiceSlug={item.voice_slug} />
                </p>
                <p
                  className="font-display text-[20px] leading-tight text-ink truncate mt-0.5 group-hover:text-accent transition-colors"
                  style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
                >
                  {item.template_id}
                </p>
                <p className="font-mono text-[11px] text-ink-soft tracking-[0.02em] mt-1 truncate">
                  {item.filename} · {item.bytes.toLocaleString()} bytes · sha {shortSha(item.sha256)}
                </p>
              </div>
              <span className="font-sans text-[12px] font-medium text-accent group-hover:underline underline-offset-2 whitespace-nowrap">
                Edit →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Judges are global + read-only — never voice-scoped, never editable. They are
 * listed for reference only (no link to the editor, which rejects them). */
function JudgesSection({ items }: { items: JudgeTemplateListItem[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="kicker">
          Shared (judges) <span className="text-ink">· {items.length}</span>
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          Global eval prompts · read-only
        </span>
      </div>
      <ul className="border-t border-rule">
        {items.map((item) => (
          <li
            key={item.template_id}
            className="grid grid-cols-[1fr_auto] gap-4 py-4 items-center border-b border-rule"
          >
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                Judge · shared
              </p>
              <p
                className="font-display text-[20px] leading-tight text-ink-soft truncate mt-0.5"
                style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
              >
                {item.template_id}
              </p>
              <p className="font-mono text-[11px] text-ink-soft tracking-[0.02em] mt-1 truncate">
                {item.filename} · {item.bytes.toLocaleString()} bytes · sha {shortSha(item.sha256)}
              </p>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint whitespace-nowrap">
              read-only
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function PromptsListPage() {
  const personasQ = useQuery({
    queryKey: ["personas", false],
    queryFn: () => personasApi.list(false),
  });

  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);

  const personas = useMemo(() => personasQ.data ?? [], [personasQ.data]);
  // Default to bowtie-editor when present, else the first available voice.
  const activeVoice = useMemo(() => {
    if (selectedVoice) return selectedVoice;
    if (personas.some((p) => p.slug === DEFAULT_VOICE)) return DEFAULT_VOICE;
    return personas[0]?.slug ?? DEFAULT_VOICE;
  }, [selectedVoice, personas]);

  const q = useQuery({
    queryKey: ["prompts", "templates", activeVoice],
    queryFn: () => promptsApi.listTemplates(activeVoice),
  });

  const items = q.data?.templates ?? [];
  const judges = q.data?.judges ?? [];
  const agents = items.filter((i) => i.category === "agent");
  const partials = items.filter((i) => i.category === "partial");

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <SectionHead
        kicker="Style Sheet · Prompts"
        hed="Prompt Library"
        dek="Every system prompt and shared partial that ships to Gemini, scoped per voice. Edits land on the next run — there is no hot reload mid-flight."
      />

      <div className="mt-6">
        {personas.length > 0 && (
          <VoiceSelector personas={personas} value={activeVoice} onChange={setSelectedVoice} />
        )}
      </div>

      <Tabs defaultValue="templates" className="mt-8">
        <TabsList variant="line" className="border-b border-rule">
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="source-policy">Source Policy</TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="pt-8">
          {q.isLoading && <p className="text-ink-faint">Loading templates…</p>}
          {q.isError && (
            <p className="text-accent-deep text-[13px] mt-6">Failed to load templates.</p>
          )}
          <div className="space-y-10">
            <Section
              title="Agent prompts"
              hint="Full system prompts"
              items={agents}
              voice={activeVoice}
            />
            <Section
              title="Shared partials"
              hint="Included by `{{include:NAME}}`"
              items={partials}
              voice={activeVoice}
            />
            <JudgesSection items={judges} />
          </div>
        </TabsContent>

        <TabsContent value="source-policy" className="pt-8">
          <SourcePolicyEditor voice={activeVoice} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
