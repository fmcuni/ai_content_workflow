"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { SectionHead } from "@/components/SectionHead";
import {
  GlossaryTable,
  emptyEntry,
  parseCsv,
} from "@/components/voices/GlossaryTable";
import { CopyToVoiceDialog } from "@/components/voices/CopyToVoiceDialog";
import { personasApi } from "@/lib/api";
import type { GlossaryEntry } from "@/lib/types";

interface GlossaryPageProps {
  params: Promise<{ slug: string }>;
}

export default function GlossaryPage({ params }: GlossaryPageProps) {
  const { slug } = use(params);
  const qc = useQueryClient();

  const personaQ = useQuery({
    queryKey: ["persona", slug],
    queryFn: () => personasApi.get(slug),
  });
  const personasQ = useQuery({
    queryKey: ["personas", false],
    queryFn: () => personasApi.list(false),
  });

  const persona = personaQ.data;
  const [draft, setDraft] = useState<GlossaryEntry[] | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const entries: GlossaryEntry[] = useMemo(() => {
    if (draft !== null) return draft;
    return persona?.glossary ?? [];
  }, [draft, persona]);

  const dirty = draft !== null;

  const saveMut = useMutation({
    mutationFn: (glossary: GlossaryEntry[]) =>
      personasApi.update(slug, { glossary }),
    onSuccess: () => {
      toast.success("Glossary saved");
      qc.invalidateQueries({ queryKey: ["persona", slug] });
      qc.invalidateQueries({ queryKey: ["personas"] });
      setDraft(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (personaQ.isLoading) {
    return <p className="px-10 py-10 text-ink-faint">Loading glossary…</p>;
  }
  if (personaQ.isError || !persona) {
    return (
      <p className="px-10 py-10 text-accent-deep text-[13px]">
        Failed to load voice &ldquo;{slug}&rdquo;.
      </p>
    );
  }

  const otherPersonas = (personasQ.data ?? []).filter((p) => p.slug !== slug);

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 space-y-8">
      <SectionHead
        kicker={`Voice · ${persona.slug}`}
        hed={`Glossary — ${persona.name}`}
        dek="Preferred terms, variants to swap away from, and per-term notes that flow into every writer and audit prompt."
      />

      <nav className="flex items-center gap-4 font-mono text-[11px] tracking-wider uppercase text-ink-faint">
        <Link href="/voices" className="hover:text-ink">← All voices</Link>
        <span aria-hidden>·</span>
        <span className="text-ink">Glossary</span>
      </nav>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="kicker">{entries.length} entries</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDraft([...entries, emptyEntry()])}
              className="border border-rule px-3 py-1.5 text-[12px] uppercase tracking-wider hover:bg-paper-deep/60"
            >
              ＋ Add term
            </button>
            <button
              type="button"
              onClick={() => setCsvOpen(true)}
              className="border border-rule px-3 py-1.5 text-[12px] uppercase tracking-wider hover:bg-paper-deep/60"
            >
              Paste CSV
            </button>
            <button
              type="button"
              onClick={() => setCopyOpen(true)}
              disabled={otherPersonas.length === 0 || persona.glossary.length === 0}
              className="border border-rule px-3 py-1.5 text-[12px] uppercase tracking-wider hover:bg-paper-deep/60 disabled:opacity-40"
              title={
                persona.glossary.length === 0
                  ? "Save terms first before copying to another voice."
                  : undefined
              }
            >
              Copy to another voice →
            </button>
          </div>
        </div>

        <GlossaryTable
          entries={entries}
          onChange={(next) => setDraft(next)}
        />

        <div className="flex items-center justify-between border-t border-rule pt-4">
          <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">
            Glossary is injected into the persona prompt block, filtered to terms present in the current brief/draft.
          </p>
          <div className="flex items-center gap-3">
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="text-[12px] uppercase tracking-wider text-ink-faint hover:text-ink"
              >
                Discard
              </button>
            )}
            <button
              type="button"
              disabled={!dirty || saveMut.isPending}
              onClick={() => saveMut.mutate(entries.filter((e) => e.term.trim()))}
              className="bg-ink text-paper px-4 py-2 text-[12px] tracking-wider uppercase disabled:opacity-40"
            >
              {saveMut.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          </div>
        </div>
      </section>

      <section className="border-t border-rule pt-6 space-y-3">
        <h3 className="kicker">How glossaries shape output</h3>
        <ul className="text-[13px] text-ink-soft leading-relaxed list-disc pl-5 max-w-[68ch]">
          <li>
            Industry practice (Trados, memoQ, Phrase, AP/Reuters house style)
            treats glossary entries as records: <em>preferred</em> form,
            {" "}<em>variants to avoid</em>, status, and notes — not just two flat lists.
          </li>
          <li>
            For large termbases, leading systems inject only the entries whose
            terms appear in the current brief or draft to keep prompts bounded
            and to surface the right guidance at the right moment.
          </li>
          <li>
            <em>Avoid</em> entries with a populated <em>Preferred</em> tell the model
            what to swap to — far more effective than a bare ban list.
          </li>
          <li>
            <em>Forbidden</em> = never use. <em>DNT</em> = leave the term in its
            original language (brand names, regulator names, product codes).
          </li>
        </ul>
      </section>

      {csvOpen && (
        <CsvDialog
          onClose={() => setCsvOpen(false)}
          onImport={(imported) => {
            setDraft([...entries, ...imported]);
            setCsvOpen(false);
          }}
        />
      )}

      {copyOpen && (
        <CopyToVoiceDialog
          sourcePersona={persona}
          candidates={otherPersonas}
          onClose={() => setCopyOpen(false)}
        />
      )}
    </div>
  );
}

function CsvDialog({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (entries: GlossaryEntry[]) => void;
}) {
  const [text, setText] = useState(
    "# term,preferred,variants (pipe-separated),status,notes\n# status: preferred | avoid | forbidden | do_not_translate\n",
  );
  const parsed = parseCsv(text);
  return (
    <>
      <div className="fixed inset-0 bg-ink/30 z-40" onClick={onClose} aria-hidden />
      <div className="fixed inset-x-0 top-16 mx-auto z-50 max-w-[720px] bg-paper border border-rule shadow-2xl p-5 space-y-4">
        <header className="flex items-center justify-between">
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint">
            Paste CSV · {parsed.length} parsed
          </p>
          <button onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">×</button>
        </header>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          className="w-full border border-rule bg-paper p-3 font-mono text-[12px] focus:outline-none focus:border-ink"
          placeholder="自願醫保,自願醫保,自愿医保|VHIS,preferred,Use HK form"
        />
        <div className="flex items-center justify-end gap-3">
          <button onClick={onClose} className="text-[12px] uppercase tracking-wider text-ink-faint hover:text-ink">
            Cancel
          </button>
          <button
            disabled={parsed.length === 0}
            onClick={() => onImport(parsed)}
            className="bg-ink text-paper px-4 py-2 text-[12px] tracking-wider uppercase disabled:opacity-40"
          >
            Append {parsed.length}
          </button>
        </div>
      </div>
    </>
  );
}
