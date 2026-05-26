"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { personasApi } from "@/lib/api";
import type { Persona, PersonaIn } from "@/lib/types";

interface ComposeDrawerProps {
  mode: { kind: "create" } | { kind: "edit"; persona: Persona };
  onClose: () => void;
  onSaved: (slug: string) => void;
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

export function ComposeDrawer({ mode, onClose, onSaved }: ComposeDrawerProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<PersonaIn>(
    mode.kind === "create" ? emptyForm() : fromPersona(mode.persona),
  );

  const cleanLists = (body: PersonaIn): PersonaIn => ({
    ...body,
    voice_rules: body.voice_rules.filter(Boolean),
    banned_terms: body.banned_terms.filter(Boolean),
    required_phrasings: body.required_phrasings.filter(Boolean),
    tone_examples: {
      good: ((body.tone_examples.good ?? []) as string[]).filter(Boolean),
      bad: ((body.tone_examples.bad ?? []) as string[]).filter(Boolean),
    },
  });

  const createMut = useMutation({
    mutationFn: (body: PersonaIn) => personasApi.create(body),
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
    onError: (e: Error) => toast.error(e.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = cleanLists(form);
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
        onClick={onClose}
        aria-hidden
      />
      <aside className="fixed right-0 top-0 bottom-0 z-50 w-full md:w-[460px] bg-paper border-l border-rule overflow-y-auto">
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <header className="flex items-center justify-between">
            <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint">
              {mode.kind === "create" ? "Compose · New voice" : `Edit · ${mode.persona.slug}`}
            </p>
            <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">
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
                onClick={() => {
                  if (
                    confirm(
                      `Archive "${mode.persona.name}"? Existing runs still resolve; new runs won't see it.`,
                    )
                  ) {
                    archiveMut.mutate(mode.persona.slug);
                  }
                }}
                className="text-accent-deep text-[12px] hover:underline"
              >
                Archive this voice
              </button>
            )}
          </footer>
        </form>
      </aside>
    </>
  );
}
