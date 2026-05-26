"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { personasApi } from "@/lib/api";
import type { Persona } from "@/lib/types";

interface StyleCardProps {
  persona: Persona;
  onEdit: () => void;
}

export function StyleCard({ persona, onEdit }: StyleCardProps) {
  const usage = useQuery({
    queryKey: ["persona-usage", persona.slug],
    queryFn: () => personasApi.usage(persona.slug),
  });

  const goodTone = (persona.tone_examples.good ?? []) as string[];
  const badTone = (persona.tone_examples.bad ?? []) as string[];

  return (
    <article className="space-y-8">
      <header className="flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint">
            {persona.slug}
          </p>
          <h2
            className="font-display text-[64px] md:text-[88px] leading-[1.05] text-ink"
            style={{ fontVariationSettings: '"opsz" 144, "SOFT" 80' }}
          >
            {persona.name}
          </h2>
          {usage.data && (
            <p className="mt-2 font-mono text-[11px] tracking-wider text-ink-faint">
              {usage.data.total} runs
              {Object.entries(usage.data.by_status).map(([s, n]) => ` · ${s}: ${n}`).join("")}
            </p>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Link
            href={`/voices/${persona.slug}/glossary`}
            className="text-[12px] tracking-wider uppercase text-ink-soft hover:text-accent transition-colors"
          >
            Glossary ({persona.glossary?.length ?? 0}) →
          </Link>
          <button
            type="button"
            onClick={onEdit}
            className="text-[12px] tracking-wider uppercase text-ink-soft hover:text-accent transition-colors"
          >
            Edit voice →
          </button>
        </div>
      </header>

      <section>
        <h3 className="kicker mb-3">語氣規則 · Voice rules</h3>
        <ul className="space-y-1.5 text-[15px] leading-relaxed text-ink-soft max-w-[60ch]">
          {persona.voice_rules.map((rule, i) => (
            <li key={i} className="pl-4 -indent-4">· {rule}</li>
          ))}
        </ul>
      </section>

      {(persona.banned_terms.length > 0 || persona.required_phrasings.length > 0) && (
        <section>
          <h3 className="kicker mb-3">字詞紅線 · Vocabulary</h3>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1px_1fr] gap-6">
            <div>
              <h4 className="kicker mb-2">避免 · Avoid</h4>
              {persona.banned_terms.length > 0 ? (
                <ul className="space-y-1.5">
                  {persona.banned_terms.map((term, i) => (
                    <li
                      key={i}
                      className="font-display text-[20px] text-ink-faint"
                    >
                      <s className="decoration-accent decoration-2">{term}</s>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-faint italic text-[14px]">—</p>
              )}
            </div>
            <div className="bg-rule hidden md:block" />
            <div>
              <h4 className="kicker mb-2">保留 · Prefer</h4>
              {persona.required_phrasings.length > 0 ? (
                <ul className="space-y-1.5">
                  {persona.required_phrasings.map((term, i) => (
                    <li
                      key={i}
                      className="font-display text-[20px] text-ink"
                      style={{ fontVariationSettings: '"opsz" 36' }}
                    >
                      {term}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-faint italic text-[14px]">—</p>
              )}
            </div>
          </div>
        </section>
      )}

      {Object.keys(persona.disclaimer_templates).length > 0 && (
        <section>
          <h3 className="kicker mb-3">免責聲明 · Disclaimer templates</h3>
          <dl className="space-y-4">
            {Object.entries(persona.disclaimer_templates).map(([key, tpl]) => (
              <div key={key}>
                <dt className="font-mono text-[11px] tracking-wider uppercase text-ink-faint">{key}</dt>
                {tpl.condition && (
                  <dd className="font-mono text-[11px] tracking-wider text-ink-faint mt-1">
                    當 · When: {tpl.condition}
                  </dd>
                )}
                <dd className="font-display italic text-ink-soft mt-1">{tpl.disclaimer}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {(goodTone.length > 0 || badTone.length > 0) && (
        <section className="grid grid-cols-1 md:grid-cols-[1fr_1px_1fr] gap-6">
          <div>
            <h3 className="kicker mb-2">好 · Tone — good</h3>
            {goodTone.map((q, i) => (
              <blockquote
                key={i}
                className="font-display italic text-ink text-[18px] leading-snug mb-3 max-w-[40ch]"
              >
                「{q}」
              </blockquote>
            ))}
          </div>
          <div className="bg-rule hidden md:block" />
          <div>
            <h3 className="kicker mb-2">壞 · Tone — bad</h3>
            {badTone.map((q, i) => (
              <blockquote
                key={i}
                className="font-display italic text-ink-faint text-[18px] leading-snug mb-3 line-through max-w-[40ch]"
              >
                「{q}」
              </blockquote>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}
