"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { SectionHead } from "@/components/SectionHead";
import { promptsApi } from "@/lib/api";
import type { PromptTemplateListItem } from "@/lib/types";

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function Section({
  title,
  hint,
  items,
}: {
  title: string;
  hint: string;
  items: PromptTemplateListItem[];
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
              href={`/prompts/${item.template_id}`}
              className="grid grid-cols-[1fr_auto] gap-4 py-4 items-center transition-colors hover:bg-paper-deep/60 group"
            >
              <div className="min-w-0">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  {item.category === "partial" ? "Partial" : "Agent prompt"}
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

export default function PromptsListPage() {
  const q = useQuery({
    queryKey: ["prompts", "templates"],
    queryFn: () => promptsApi.listTemplates(),
  });

  const items = q.data?.templates ?? [];
  const agents = items.filter((i) => i.category === "agent");
  const partials = items.filter((i) => i.category === "partial");

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <SectionHead
        kicker="Style Sheet · Prompts"
        hed="Prompt Library"
        dek="Every system prompt and shared partial that ships to Gemini. Edits land on the next run — there is no hot reload mid-flight."
      />

      {q.isLoading && <p className="text-ink-faint">Loading templates…</p>}
      {q.isError && (
        <p className="text-accent-deep text-[13px] mt-6">Failed to load templates.</p>
      )}

      <div className="mt-8 space-y-10">
        <Section title="Agent prompts" hint="Full system prompts" items={agents} />
        <Section title="Shared partials" hint="Included by `{{include:NAME}}`" items={partials} />
      </div>
    </div>
  );
}
