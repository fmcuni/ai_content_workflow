"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { RoleButton } from "@/components/RoleGate";
import { SourcePolicyEditor } from "@/components/SourcePolicyEditor";
import { GlossaryTable, emptyEntry } from "@/components/voices/GlossaryTable";
import { HK_ZH_LOCALE, LocaleFields } from "@/components/voices/LocaleFields";
import { personasApi, publishTargetsApi } from "@/lib/api";
import type { GlossaryEntry, Persona, VoiceLocale } from "@/lib/types";
import { cn } from "@/lib/utils";

export type VoiceConfigTab = "locale" | "source_policy" | "glossary" | "publish_target";

const TABS: { tab: VoiceConfigTab; label: string }[] = [
  { tab: "locale", label: "Locale" },
  { tab: "source_policy", label: "Source policy" },
  { tab: "glossary", label: "Glossary" },
  { tab: "publish_target", label: "Publish target" },
];

interface VoiceConfigInspectorProps {
  voice: string;
  initialTab: VoiceConfigTab;
}

/**
 * Voice-level config tabs surfaced in the studio inspector. Each panel reuses
 * the canonical editor for that concern — no logic is duplicated here.
 */
export function VoiceConfigInspector({ voice, initialTab }: VoiceConfigInspectorProps) {
  const [tab, setTab] = useState<VoiceConfigTab>(initialTab);
  // Re-sync when the operator clicks a different context node while the
  // inspector is already open. Store-previous-prop pattern (set during render,
  // not in an effect) so there's no extra commit + cascading render.
  const [syncedInitial, setSyncedInitial] = useState(initialTab);
  if (initialTab !== syncedInitial) {
    setSyncedInitial(initialTab);
    setTab(initialTab);
  }

  return (
    <div>
      <div className="inline-flex flex-wrap gap-1 mb-4">
        {TABS.map((t) => (
          <button
            key={t.tab}
            type="button"
            aria-pressed={tab === t.tab}
            onClick={() => setTab(t.tab)}
            className={cn(
              "font-mono text-[10px] tracking-[0.12em] uppercase border rounded-sm px-2 py-1 transition-colors",
              tab === t.tab
                ? "border-accent text-accent bg-accent/5"
                : "border-rule text-ink-faint hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "locale" && <LocalePanel voice={voice} />}
      {tab === "source_policy" && <SourcePolicyEditor voice={voice} />}
      {tab === "glossary" && <GlossaryPanel voice={voice} />}
      {tab === "publish_target" && <PublishTargetPanel voice={voice} />}
    </div>
  );
}

function LocalePanel({ voice }: { voice: string }) {
  const qc = useQueryClient();
  const personaQ = useQuery({ queryKey: ["persona", voice], queryFn: () => personasApi.get(voice) });
  const [draft, setDraft] = useState<VoiceLocale | null>(null);
  // Seed/re-seed the draft from the fetched persona without an effect: track the
  // locale object's identity (fresh per fetch) and sync during render.
  const [syncedLocale, setSyncedLocale] = useState<VoiceLocale | null>(null);
  if (personaQ.data && personaQ.data.locale !== syncedLocale) {
    setSyncedLocale(personaQ.data.locale);
    setDraft(personaQ.data.locale);
  }

  const saveMut = useMutation({
    mutationFn: (locale: VoiceLocale) => personasApi.update(voice, { locale }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["persona", voice] });
      void qc.invalidateQueries({ queryKey: ["personas"] });
    },
  });

  if (personaQ.isPending || !draft) return <p className="text-ink-faint text-[12px]">Loading locale…</p>;
  if (personaQ.isError)
    return <p className="text-accent-deep text-[12px]">Failed to load this voice.</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(personaQ.data?.locale);

  return (
    <div className="space-y-4">
      <p className="text-ink-faint text-[11px] leading-snug">
        Brand, language and market tokens substituted into every persona-using prompt. Blank fields
        fall back to the HK-ZH defaults shown.
      </p>
      <LocaleFields locale={draft} defaults={HK_ZH_LOCALE} onChange={setDraft} />
      <div className="flex items-center gap-3">
        <RoleButton
          need="manage_personas"
          disabled={!dirty || saveMut.isPending}
          onClick={() => saveMut.mutate(draft)}
        >
          {saveMut.isPending ? "Saving…" : "Save locale"}
        </RoleButton>
        {dirty && <span className="font-mono text-[10px] uppercase tracking-wider text-accent">unsaved</span>}
        {saveMut.isError && <span className="text-accent-deep text-[11px]">Save failed.</span>}
      </div>
    </div>
  );
}

function GlossaryPanel({ voice }: { voice: string }) {
  const qc = useQueryClient();
  const personaQ = useQuery({ queryKey: ["persona", voice], queryFn: () => personasApi.get(voice) });
  const [draft, setDraft] = useState<GlossaryEntry[] | null>(null);

  // Sync the editable glossary draft from the fetched persona during render
  // (the array ref is fresh per fetch) instead of in an effect.
  const [syncedGlossary, setSyncedGlossary] = useState<GlossaryEntry[] | null>(null);
  if (personaQ.data && personaQ.data.glossary !== syncedGlossary) {
    setSyncedGlossary(personaQ.data.glossary);
    setDraft(personaQ.data.glossary);
  }

  const saveMut = useMutation({
    mutationFn: (glossary: GlossaryEntry[]) => personasApi.update(voice, { glossary }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["persona", voice] });
      void qc.invalidateQueries({ queryKey: ["personas"] });
    },
  });

  if (personaQ.isPending || !draft)
    return <p className="text-ink-faint text-[12px]">Loading glossary…</p>;
  if (personaQ.isError)
    return <p className="text-accent-deep text-[12px]">Failed to load this voice.</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(personaQ.data?.glossary);

  return (
    <div className="space-y-3">
      <p className="text-ink-faint text-[11px] leading-snug">
        Term preferences enforced across this voice’s copy. Full management lives on the{" "}
        <Link href={`/voices/${encodeURIComponent(voice)}/glossary`} className="text-accent hover:underline">
          glossary page
        </Link>
        .
      </p>
      <GlossaryTable entries={draft} onChange={setDraft} />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setDraft([...draft, emptyEntry()])}
          className="font-mono text-[11px] uppercase tracking-wider text-ink-faint hover:text-ink border border-rule rounded-sm px-2 py-1"
        >
          + Add term
        </button>
        <RoleButton
          need="manage_personas"
          disabled={!dirty || saveMut.isPending}
          onClick={() => saveMut.mutate(draft)}
        >
          {saveMut.isPending ? "Saving…" : "Save glossary"}
        </RoleButton>
        {dirty && <span className="font-mono text-[10px] uppercase tracking-wider text-accent">unsaved</span>}
      </div>
    </div>
  );
}

function PublishTargetPanel({ voice }: { voice: string }) {
  const qc = useQueryClient();
  const personaQ = useQuery({ queryKey: ["persona", voice], queryFn: () => personasApi.get(voice) });
  const targetsQ = useQuery({
    queryKey: ["publish-targets", false],
    queryFn: () => publishTargetsApi.list(false),
  });
  const [selected, setSelected] = useState<string | null>(null);

  // Sync the selected target from the fetched persona during render (track the
  // persona object's identity, since publish_target_id can legitimately be null).
  const [syncedPersona, setSyncedPersona] = useState<Persona | null>(null);
  if (personaQ.data && personaQ.data !== syncedPersona) {
    setSyncedPersona(personaQ.data);
    setSelected(personaQ.data.publish_target_id);
  }

  const saveMut = useMutation({
    mutationFn: (publish_target_id: string | null) => personasApi.update(voice, { publish_target_id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["persona", voice] });
      void qc.invalidateQueries({ queryKey: ["personas"] });
    },
  });

  const readinessQ = useQuery({
    enabled: Boolean(selected),
    queryKey: ["publish-target-readiness", selected],
    queryFn: () => publishTargetsApi.readiness(selected!),
    retry: false,
  });

  if (personaQ.isPending) return <p className="text-ink-faint text-[12px]">Loading…</p>;
  if (personaQ.isError)
    return <p className="text-accent-deep text-[12px]">Failed to load this voice.</p>;

  const dirty = selected !== (personaQ.data?.publish_target_id ?? null);

  return (
    <div className="space-y-4">
      <p className="text-ink-faint text-[11px] leading-snug">
        The CMS instance this voice publishes to. Manage credentials on the{" "}
        <Link href="/settings/publish-targets" className="text-accent hover:underline">
          publish targets
        </Link>{" "}
        page.
      </p>
      <select
        value={selected ?? ""}
        onChange={(e) => setSelected(e.target.value || null)}
        className="w-full font-mono text-[12px] text-ink bg-paper border border-rule rounded-sm px-2 py-1.5"
      >
        <option value="">— none (default Bowtie WP) —</option>
        {(targetsQ.data ?? []).map((t) => (
          <option key={t.publish_target_id} value={t.publish_target_id}>
            {t.name} · {t.kind} {t.status === "active" ? "" : `(${t.status})`}
          </option>
        ))}
      </select>

      {selected && readinessQ.data && (
        <ul className="font-mono text-[11px] space-y-0.5">
          {(
            [
              ["base URL", readinessQ.data.base_url],
              ["username", readinessQ.data.username],
              ["app password", readinessQ.data.app_password],
            ] as const
          ).map(([label, ok]) => (
            <li key={label} className={ok ? "text-ink-soft" : "text-accent-deep"}>
              {ok ? "✓" : "✕"} {label}
            </li>
          ))}
          <li className={readinessQ.data.ready ? "text-ink" : "text-accent-deep"}>
            {readinessQ.data.ready ? "● ready to publish" : "○ not ready — missing credentials"}
          </li>
        </ul>
      )}

      <div className="flex items-center gap-3">
        <RoleButton
          need="manage_personas"
          disabled={!dirty || saveMut.isPending}
          onClick={() => saveMut.mutate(selected)}
        >
          {saveMut.isPending ? "Saving…" : "Save target"}
        </RoleButton>
        {dirty && <span className="font-mono text-[10px] uppercase tracking-wider text-accent">unsaved</span>}
      </div>
    </div>
  );
}
