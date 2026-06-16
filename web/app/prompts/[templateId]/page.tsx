"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, use } from "react";

import { PromptEditor } from "@/components/prompts/PromptEditor";

// `params` is a Promise in Next.js 16 — must be unwrapped with `use()`. The
// editor reads `?voice=` via useSearchParams, which Next 16 requires to sit
// behind a Suspense boundary (mirrors app/runs/new + app/login).
export default function PromptEditorPage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  return (
    <Suspense fallback={null}>
      <PromptEditorContent params={params} />
    </Suspense>
  );
}

function PromptEditorContent({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = use(params);
  // The prompt library is per-voice; `?voice=` carries the selected voice from
  // the list page. Default to bowtie-editor to match the server default.
  const searchParams = useSearchParams();
  const voice = searchParams.get("voice") ?? "bowtie-editor";

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <Link
        href={`/prompts?voice=${encodeURIComponent(voice)}`}
        className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint hover:text-accent inline-block mb-3"
      >
        ← Prompt Library
      </Link>

      <PromptEditor templateId={templateId} voice={voice} />
    </div>
  );
}
