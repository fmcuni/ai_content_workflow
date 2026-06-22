"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";

import { RoleButton } from "@/components/RoleGate";
import { SourcePolicyEditor } from "@/components/SourcePolicyEditor";
import { GlossaryTable, emptyEntry } from "@/components/voices/GlossaryTable";
import { HK_ZH_LOCALE, LocaleFields } from "@/components/voices/LocaleFields";
import { personasApi, publishTargetsApi } from "@/lib/api";
import type { GlossaryEntry, VoiceLocale } from "@/lib/types";
import { isGlossaryDraft, isLocaleDraft, isPublishTargetDraft } from "@/lib/voice-studio/draft-store";
import { useStudioDraft } from "@/lib/voice-studio/draft-store-provider";
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
  const studio = useStudioDraft();
  const personaQ = useQuery({ queryKey: ["persona", voice], queryFn: () => personasApi.get(voice) });
  const [draft, setDraft] = useState<VoiceLocale | null>(null);
  // Seed/re-seed the draft from the fetched persona post-commit (keyed on the
  // locale object's identity, which is fresh per fetch) rather than reading the
  // store during a render-phase setState. An existing Studio store draft takes
  // precedence so a prior edit is reflected when the panel remounts (tab switch).
  const storedLocale = studio?.state.config.locale;
  useEffect(() => {
    if (!personaQ.data) return;
    // Seed once per fetched persona; the store value wins on mount, later edits
    // mirror into the store via onChange. `storedLocale` is intentionally read at
    // seed time only — re-seeding on every store edit would clobber typing. The
    // setState here is the supported "sync from an external system (the query)"
    // case, not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(isLocaleDraft(storedLocale) ? storedLocale.locale : personaQ.data.locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaQ.data]);

  const saveMut = useMutation({
    mutationFn: (locale: VoiceLocale) => personasApi.update(voice, { locale }),
    onSuccess: () => {
      studio?.clearConfigDraft("locale");
      void qc.invalidateQueries({ queryKey: ["persona", voice] });
      void qc.invalidateQueries({ queryKey: ["personas"] });
    },
  });

  if (personaQ.isPending || !draft) return <p className="text-ink-faint text-[12px]">Loading locale…</p>;
  if (personaQ.isError)
    return <p className="text-accent-deep text-[12px]">Failed to load this voice.</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(personaQ.data?.locale);

  // Edits update the rendered draft and (in Studio) the shared store so Save-all
  // and the live preview reflect them; clearing back to the server value drops
  // the store draft.
  const onChange = (next: VoiceLocale) => {
    setDraft(next);
    if (studio) {
      if (JSON.stringify(next) === JSON.stringify(personaQ.data?.locale)) {
        studio.clearConfigDraft("locale");
      } else {
        studio.setConfigDraft("locale", { kind: "locale", locale: next });
      }
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-ink-faint text-[11px] leading-snug">
        Brand, language and market tokens substituted into every persona-using prompt. Blank fields
        fall back to the HK-ZH defaults shown.
      </p>
      <LocaleFields locale={draft} defaults={HK_ZH_LOCALE} onChange={onChange} />
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
  const studio = useStudioDraft();
  const personaQ = useQuery({ queryKey: ["persona", voice], queryFn: () => personasApi.get(voice) });
  const [draft, setDraft] = useState<GlossaryEntry[] | null>(null);

  // Seed the editable glossary draft from the fetched persona post-commit (keyed
  // on the array ref, fresh per fetch) rather than reading the store during a
  // render-phase setState. An existing Studio store draft takes precedence so a
  // prior edit survives a tab switch.
  const storedGlossary = studio?.state.config.glossary;
  useEffect(() => {
    if (!personaQ.data) return;
    // Seed once per fetched persona; store wins on mount, edits mirror via onChange.
    // setState here syncs from the query (an external system), not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(isGlossaryDraft(storedGlossary) ? storedGlossary.glossary : personaQ.data.glossary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaQ.data]);

  const saveMut = useMutation({
    mutationFn: (glossary: GlossaryEntry[]) => personasApi.update(voice, { glossary }),
    onSuccess: () => {
      studio?.clearConfigDraft("glossary");
      void qc.invalidateQueries({ queryKey: ["persona", voice] });
      void qc.invalidateQueries({ queryKey: ["personas"] });
    },
  });

  if (personaQ.isPending || !draft)
    return <p className="text-ink-faint text-[12px]">Loading glossary…</p>;
  if (personaQ.isError)
    return <p className="text-accent-deep text-[12px]">Failed to load this voice.</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(personaQ.data?.glossary);

  // Edits update the rendered draft and (in Studio) the shared store; reverting
  // to the server glossary drops the store draft.
  const onChange = (next: GlossaryEntry[]) => {
    setDraft(next);
    if (studio) {
      if (JSON.stringify(next) === JSON.stringify(personaQ.data?.glossary)) {
        studio.clearConfigDraft("glossary");
      } else {
        studio.setConfigDraft("glossary", { kind: "glossary", glossary: next });
      }
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-ink-faint text-[11px] leading-snug">
        Term preferences enforced across this voice’s copy. Full management lives on the{" "}
        <Link href={`/voices/${encodeURIComponent(voice)}/glossary`} className="text-accent hover:underline">
          glossary page
        </Link>
        .
      </p>
      <GlossaryTable entries={draft} onChange={onChange} />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChange([...draft, emptyEntry()])}
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
        {saveMut.isError && <span className="text-accent-deep text-[11px]">Save failed.</span>}
      </div>
    </div>
  );
}

function PublishTargetPanel({ voice }: { voice: string }) {
  const qc = useQueryClient();
  const studio = useStudioDraft();
  const personaQ = useQuery({ queryKey: ["persona", voice], queryFn: () => personasApi.get(voice) });
  const targetsQ = useQuery({
    queryKey: ["publish-targets", false],
    queryFn: () => publishTargetsApi.list(false),
  });
  const [selected, setSelected] = useState<string | null>(null);

  // Seed the selected target from the fetched persona post-commit (keyed on the
  // persona object's identity, since publish_target_id can legitimately be null)
  // rather than reading the store during a render-phase setState. An existing
  // Studio store draft takes precedence so a prior pick survives a tab switch.
  const storedTarget = studio?.state.config.publish_target;
  useEffect(() => {
    if (!personaQ.data) return;
    // Seed once per fetched persona; store wins on mount, picks mirror via onChange.
    // setState here syncs from the query (an external system), not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(
      isPublishTargetDraft(storedTarget) ? storedTarget.publishTargetId : personaQ.data.publish_target_id,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaQ.data]);

  const saveMut = useMutation({
    mutationFn: (publish_target_id: string | null) => personasApi.update(voice, { publish_target_id }),
    onSuccess: () => {
      studio?.clearConfigDraft("publish_target");
      void qc.invalidateQueries({ queryKey: ["persona", voice] });
      void qc.invalidateQueries({ queryKey: ["personas"] });
    },
  });

  // Selecting a target updates local state and (in Studio) the store; choosing
  // the persona's stored value drops the draft.
  const onSelect = (next: string | null) => {
    setSelected(next);
    if (studio) {
      if (next === (personaQ.data?.publish_target_id ?? null)) {
        studio.clearConfigDraft("publish_target");
      } else {
        studio.setConfigDraft("publish_target", { kind: "publish_target", publishTargetId: next });
      }
    }
  };

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
      {targetsQ.isError && (
        <p className="text-accent-deep text-[11px]">
          Failed to load publish targets — only the default Bowtie WP option is shown.
        </p>
      )}
      <select
        value={selected ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
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
        {saveMut.isError && <span className="text-accent-deep text-[11px]">Save failed.</span>}
      </div>
    </div>
  );
}
