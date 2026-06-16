"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { personasApi, publishTargetsApi } from "@/lib/api";
import type { DisclaimerTemplate, Persona, PersonaIn, VoiceLocale } from "@/lib/types";
import { HK_ZH_LOCALE, LocaleField } from "./LocaleFields";

interface ComposeDrawerProps {
  mode: { kind: "create" } | { kind: "edit"; persona: Persona };
  onClose: () => void;
  onSaved: (slug: string) => void;
  /** When true, this is the last non-archived voice — archiving is disabled
   * (the app must keep at least one usable voice; the server also returns 409). */
  isLastVoice?: boolean;
  /** Admin-only: gate the Locale & Brand section. The page only mounts this
   * drawer for managers, so defaults true. */
  canManage?: boolean;
  /** Fired (debounced upstream) as the locale form changes, so a sibling live
   * preview can reflect the unsaved locale. */
  onLocaleChange?: (locale: VoiceLocale) => void;
}

function emptyForm(): PersonaIn {
  return {
    slug: "",
    name: "",
    voice_rules: [""],
    banned_terms: [""],
    required_phrasings: [""],
    disclaimer_templates: {},
    tone_examples: { good: [""], bad: [""] },
  };
}

function fromPersona(p: Persona): PersonaIn {
  return {
    slug: p.slug,
    name: p.name,
    voice_rules: p.voice_rules.length ? p.voice_rules : [""],
    banned_terms: p.banned_terms.length ? p.banned_terms : [""],
    required_phrasings: p.required_phrasings.length ? p.required_phrasings : [""],
    disclaimer_templates: p.disclaimer_templates,
    tone_examples: {
      good: (p.tone_examples.good ?? []).length ? p.tone_examples.good : [""],
      bad: (p.tone_examples.bad ?? []).length ? p.tone_examples.bad : [""],
    },
  };
}

function StringList({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">{label}</p>
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={v}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
            className="flex-1 border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
          />
          {values.length > 1 && (
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              className="text-ink-faint hover:text-accent-deep text-[14px]"
              aria-label="remove"
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ""])}
        className="font-mono text-[10px] tracking-wider uppercase text-ink-faint hover:text-ink"
      >
        ＋ 加一行
      </button>
    </div>
  );
}

function DisclaimerTemplateList({
  label,
  entries,
  onChange,
}: {
  label: string;
  entries: Record<string, DisclaimerTemplate>;
  onChange: (next: Record<string, DisclaimerTemplate>) => void;
}) {
  const rows = Object.entries(entries);
  return (
    <div className="space-y-3">
      <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">{label}</p>
      {rows.length === 0 && (
        <p className="font-mono text-[10px] text-ink-faint italic">No templates yet.</p>
      )}
      {rows.map(([k, v], i) => (
        <div key={i} className="border border-rule p-3 space-y-2 relative">
          <button
            type="button"
            onClick={() => {
              const next = { ...entries };
              delete next[k];
              onChange(next);
            }}
            className="absolute top-2 right-2 text-ink-faint hover:text-accent-deep text-[14px]"
            aria-label="remove"
          >
            ×
          </button>
          <div>
            <p className="font-mono text-[9px] tracking-[0.18em] uppercase text-ink-faint mb-1">
              Name · 名稱
            </p>
            <input
              value={k}
              onChange={(e) => {
                const next: Record<string, DisclaimerTemplate> = {};
                rows.forEach(([rk, rv], j) => {
                  next[j === i ? e.target.value : rk] = rv;
                });
                onChange(next);
              }}
              placeholder="e.g. medical"
              className="w-full border-b border-rule bg-transparent py-1 text-[13px] font-mono uppercase tracking-wider focus:outline-none focus:border-ink"
            />
          </div>
          <div>
            <p className="font-mono text-[9px] tracking-[0.18em] uppercase text-ink-faint mb-1">
              Condition · 顯示時機
            </p>
            <input
              value={v.condition}
              onChange={(e) =>
                onChange({ ...entries, [k]: { ...v, condition: e.target.value } })
              }
              placeholder="when to show this disclaimer"
              className="w-full border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
            />
          </div>
          <div>
            <p className="font-mono text-[9px] tracking-[0.18em] uppercase text-ink-faint mb-1">
              Disclaimer · 免責聲明
            </p>
            <textarea
              value={v.disclaimer}
              onChange={(e) =>
                onChange({ ...entries, [k]: { ...v, disclaimer: e.target.value } })
              }
              rows={2}
              placeholder="disclaimer text"
              className="w-full border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink resize-y"
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          let i = 1;
          while ((`new-${i}` in entries)) i += 1;
          onChange({ ...entries, [`new-${i}`]: { condition: "", disclaimer: "" } });
        }}
        className="font-mono text-[10px] tracking-wider uppercase text-ink-faint hover:text-ink"
      >
        ＋ add template
      </button>
    </div>
  );
}

function fromPersonaLocale(mode: ComposeDrawerProps["mode"]): VoiceLocale {
  if (mode.kind === "edit" && mode.persona.locale) {
    return mode.persona.locale;
  }
  return { ...HK_ZH_LOCALE };
}

export function ComposeDrawer({
  mode,
  onClose,
  onSaved,
  isLastVoice = false,
  canManage = true,
  onLocaleChange,
}: ComposeDrawerProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<PersonaIn>(
    mode.kind === "create" ? emptyForm() : fromPersona(mode.persona),
  );
  // Locale & Brand form state. `sources_heading` is held as string|null: the
  // text input binds to `?? ""`, and a blank string is normalised to null on
  // both change (so the banner + live preview see null) and submit.
  const [localeForm, setLocaleForm] = useState<VoiceLocale>(() => fromPersonaLocale(mode));

  function updateLocale(next: VoiceLocale) {
    const normalised: VoiceLocale = {
      ...next,
      sources_heading:
        next.sources_heading && next.sources_heading.trim() !== ""
          ? next.sources_heading
          : null,
    };
    setLocaleForm(normalised);
    onLocaleChange?.(normalised);
  }
  // CMS publish target for this voice. null = the backend's default (legacy
  // Bowtie WordPress env). Managed separately from `form` because the create
  // payload (PersonaIn) has no target field — it's applied via PATCH.
  const [targetId, setTargetId] = useState<string | null>(
    mode.kind === "edit" ? mode.persona.publish_target_id : null,
  );
  const targetsQuery = useQuery({
    queryKey: ["publish-targets"],
    queryFn: () => publishTargetsApi.list(),
  });

  // Lock background scroll while the drawer is open so the wheel/trackpad acts
  // on the panel, not the page behind it. The drawer mounts only when open, so
  // unmount restores the prior overflow.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const cleanLists = (body: PersonaIn): PersonaIn => {
    const cleanedDisclaimers: Record<string, DisclaimerTemplate> = {};
    for (const [k, v] of Object.entries(body.disclaimer_templates)) {
      const trimmed = k.trim();
      if (!trimmed || trimmed.startsWith("new-")) continue;
      cleanedDisclaimers[trimmed] = v;
    }
    return {
      ...body,
      voice_rules: body.voice_rules.filter(Boolean),
      banned_terms: body.banned_terms.filter(Boolean),
      required_phrasings: body.required_phrasings.filter(Boolean),
      disclaimer_templates: cleanedDisclaimers,
      tone_examples: {
        good: ((body.tone_examples.good ?? []) as string[]).filter(Boolean),
        bad: ((body.tone_examples.bad ?? []) as string[]).filter(Boolean),
      },
    };
  };

  const createMut = useMutation({
    // PersonaIn has no target field, so apply the chosen target via a follow-up
    // PATCH right after the voice is created (skip when left on Default).
    mutationFn: async (body: PersonaIn) => {
      const created = await personasApi.create(body);
      if (targetId !== null) {
        return personasApi.update(created.slug, { publish_target_id: targetId });
      }
      return created;
    },
    onSuccess: (p) => {
      toast.success(`Voice "${p.name}" created`);
      qc.invalidateQueries({ queryKey: ["personas"] });
      onSaved(p.slug);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ slug, body }: { slug: string; body: PersonaIn }) =>
      personasApi.update(slug, {
        name: body.name,
        voice_rules: body.voice_rules,
        banned_terms: body.banned_terms,
        required_phrasings: body.required_phrasings,
        disclaimer_templates: body.disclaimer_templates,
        tone_examples: body.tone_examples,
        locale: body.locale,
        publish_target_id: targetId,
      }),
    onSuccess: (p) => {
      toast.success(`Voice "${p.name}" updated`);
      qc.invalidateQueries({ queryKey: ["personas"] });
      qc.invalidateQueries({ queryKey: ["persona-usage", p.slug] });
      onSaved(p.slug);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const archiveMut = useMutation({
    mutationFn: (slug: string) => personasApi.archive(slug),
    onSuccess: () => {
      toast.success("Voice archived");
      qc.invalidateQueries({ queryKey: ["personas"] });
      onClose();
    },
    onError: (e: Error) =>
      toast.error(
        e.message.startsWith("409")
          ? "Cannot archive the last remaining voice."
          : e.message,
      ),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Attach the whole locale object (all 6 fields) to the submitted body;
    // `localeForm.sources_heading` is already null when blank.
    const cleaned: PersonaIn = { ...cleanLists(form), locale: localeForm };
    if (mode.kind === "create") {
      createMut.mutate(cleaned);
    } else {
      updateMut.mutate({ slug: mode.persona.slug, body: cleaned });
    }
  }

  const busy = createMut.isPending || updateMut.isPending;

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/20 z-40"
        onClick={() => {
          if (!busy && !archiveMut.isPending) onClose();
        }}
        aria-hidden
      />
      <aside className="fixed right-0 top-0 bottom-0 z-50 w-full md:w-[460px] bg-paper border-l border-rule overflow-y-auto overscroll-contain">
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <header className="flex items-center justify-between">
            <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint">
              {mode.kind === "create" ? "Compose · New voice" : `Edit · ${mode.persona.slug}`}
            </p>
            <button type="button" onClick={onClose} disabled={busy || archiveMut.isPending} className="text-ink-faint hover:text-ink disabled:opacity-40" aria-label="Close">
              ×
            </button>
          </header>

          <div className="space-y-3">
            <div>
              <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1">Slug</p>
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                disabled={mode.kind === "edit"}
                className="w-full border-b border-rule bg-transparent py-1 text-[14px] disabled:text-ink-faint focus:outline-none focus:border-ink"
                placeholder="lowercase-with-dashes"
              />
            </div>
            <div>
              <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1">Name</p>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full border-b border-rule bg-transparent py-1 text-[18px] font-display focus:outline-none focus:border-ink"
              />
            </div>
            <div>
              <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1">
                Publish target · CMS
              </p>
              <select
                value={targetId ?? ""}
                onChange={(e) => setTargetId(e.target.value === "" ? null : e.target.value)}
                disabled={targetsQuery.isLoading}
                className="w-full border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
              >
                <option value="">Default (Bowtie WordPress)</option>
                {(targetsQuery.data ?? []).map((t) => (
                  <option key={t.publish_target_id} value={t.publish_target_id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <p className="font-mono text-[9px] text-ink-faint mt-1">
                Where articles from this voice publish. Credentials are configured on the server.
              </p>
            </div>
          </div>

          <StringList
            label="Voice rules · 語氣規則"
            values={form.voice_rules}
            onChange={(next) => setForm({ ...form, voice_rules: next })}
          />
          <StringList
            label="Banned terms · 字詞禁用"
            values={form.banned_terms}
            onChange={(next) => setForm({ ...form, banned_terms: next })}
          />
          <StringList
            label="Required phrasings · 必用詞"
            values={form.required_phrasings}
            onChange={(next) => setForm({ ...form, required_phrasings: next })}
          />
          <DisclaimerTemplateList
            label="Disclaimer templates · 免責聲明"
            entries={form.disclaimer_templates}
            onChange={(next) => setForm({ ...form, disclaimer_templates: next })}
          />
          <StringList
            label="Tone — good · 好"
            values={(form.tone_examples.good ?? []) as string[]}
            onChange={(next) =>
              setForm({ ...form, tone_examples: { ...form.tone_examples, good: next } })
            }
          />
          <StringList
            label="Tone — bad · 壞"
            values={(form.tone_examples.bad ?? []) as string[]}
            onChange={(next) =>
              setForm({ ...form, tone_examples: { ...form.tone_examples, bad: next } })
            }
          />

          {canManage && (
            <section className="space-y-3 pt-4 border-t border-rule" aria-label="Locale & Brand">
              <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">
                Locale &amp; Brand · 語系與品牌
              </p>
              <LocaleField
                label="Output language · 輸出語言"
                value={localeForm.output_language}
                placeholder={HK_ZH_LOCALE.output_language}
                onChange={(v) => updateLocale({ ...localeForm, output_language: v })}
              />
              <LocaleField
                label="Brand name · 品牌名稱"
                value={localeForm.brand_name}
                placeholder={HK_ZH_LOCALE.brand_name}
                onChange={(v) => updateLocale({ ...localeForm, brand_name: v })}
              />
              <LocaleField
                label="Market · 市場"
                value={localeForm.market}
                placeholder={HK_ZH_LOCALE.market}
                onChange={(v) => updateLocale({ ...localeForm, market: v })}
              />
              <LocaleField
                label="Sources heading · 資訊來源標題"
                value={localeForm.sources_heading ?? ""}
                placeholder="(blank → follow article script)"
                onChange={(v) => updateLocale({ ...localeForm, sources_heading: v })}
              />
              <LocaleField
                label="FAQ heading · 常見問題標題"
                value={localeForm.faq_heading}
                placeholder={HK_ZH_LOCALE.faq_heading}
                onChange={(v) => updateLocale({ ...localeForm, faq_heading: v })}
              />
            </section>
          )}

          <footer className="space-y-3 pt-4 border-t border-rule">
            <button
              type="submit"
              disabled={busy || !form.slug || !form.name}
              className="w-full bg-ink text-paper py-2 text-[13px] tracking-wider uppercase disabled:opacity-40"
            >
              {busy ? "Saving…" : mode.kind === "create" ? "Create voice" : "Save changes"}
            </button>
            {mode.kind === "edit" && (
              <button
                type="button"
                disabled={busy || archiveMut.isPending || isLastVoice}
                title={
                  isLastVoice
                    ? "Cannot archive the last remaining voice — the app must keep one usable voice."
                    : undefined
                }
                onClick={() => {
                  if (
                    confirm(
                      `Archive "${mode.persona.name}"? Existing runs still resolve; new runs won't see it.`,
                    )
                  ) {
                    archiveMut.mutate(mode.persona.slug);
                  }
                }}
                className="text-accent-deep text-[12px] hover:underline disabled:opacity-40 disabled:pointer-events-none disabled:no-underline"
              >
                {archiveMut.isPending ? "Archiving…" : "Archive this voice"}
              </button>
            )}
          </footer>
        </form>
      </aside>
    </>
  );
}
