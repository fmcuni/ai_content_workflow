"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { personasApi } from "@/lib/api";
import type { Persona } from "@/lib/types";

interface DuplicateVoiceDialogProps {
  /** Voices that can be cloned (typically the non-archived personas). */
  candidates: Persona[];
  /** Pre-selected source voice (defaults to the first candidate). */
  defaultSourceSlug?: string;
  onClose: () => void;
  onDuplicated: (slug: string) => void;
}

// Mirror of the backend PersonaIn slug validator
// (^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$). Pre-validating client-side gives a
// clear message before the round-trip; the server stays authoritative.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** Turn the `http` helper's `"<status>: <body>"` error into a user-facing line. */
function friendlyError(message: string, newSlug: string, sourceSlug: string): string {
  if (message.startsWith("409")) {
    return `A voice with slug "${newSlug}" already exists. Pick a different slug.`;
  }
  if (message.startsWith("404")) {
    return `Source voice "${sourceSlug}" was not found.`;
  }
  return message;
}

/**
 * "Duplicate voice" flow: a new voice is created by deep-copying an existing one
 * (persona + its agent/partial prompt templates + source policy), under a new
 * slug + name. Replaces raw create on the Voices page so every voice starts from
 * a known-good prompt set.
 */
export function DuplicateVoiceDialog({
  candidates,
  defaultSourceSlug,
  onClose,
  onDuplicated,
}: DuplicateVoiceDialogProps) {
  const qc = useQueryClient();
  const [sourceSlug, setSourceSlug] = useState(
    defaultSourceSlug ?? candidates[0]?.slug ?? "",
  );
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Lock background scroll while the dialog is open so the page behind it stays
  // put. The dialog mounts only when open, so unmount restores the prior value.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const mut = useMutation({
    mutationFn: () => personasApi.duplicate(sourceSlug, { slug, name }),
    onSuccess: (p) => {
      toast.success(`Voice "${p.name}" created from "${sourceSlug}"`);
      qc.invalidateQueries({ queryKey: ["personas"] });
      onDuplicated(p.slug);
    },
    onError: (e: Error) => {
      const msg = friendlyError(e.message, slug, sourceSlug);
      setError(msg);
      toast.error(msg);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedSlug = slug.trim();
    const trimmedName = name.trim();
    if (!sourceSlug) {
      setError("Choose a source voice to duplicate.");
      return;
    }
    if (!SLUG_RE.test(trimmedSlug)) {
      setError("Slug must be lowercase letters, digits, and dashes (e.g. my-new-voice).");
      return;
    }
    if (trimmedName.length < 1 || trimmedName.length > 128) {
      setError("Name must be 1–128 characters.");
      return;
    }
    setSlug(trimmedSlug);
    setName(trimmedName);
    mut.mutate();
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/30 z-40"
        onClick={() => {
          if (!mut.isPending) onClose();
        }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Duplicate voice"
        className="fixed inset-x-0 top-16 mx-auto z-50 max-w-[480px] bg-paper border border-rule shadow-2xl"
      >
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <header className="flex items-center justify-between">
            <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint">
              Duplicate · New voice
            </p>
            <button
              type="button"
              onClick={onClose}
              disabled={mut.isPending}
              className="text-ink-faint hover:text-ink disabled:opacity-40"
              aria-label="Close"
            >
              ×
            </button>
          </header>

          <p className="text-[13px] text-ink-soft leading-relaxed">
            A new voice is a deep copy of an existing one — its prompt templates and
            source policy come along. Edit them afterwards under the new voice.
          </p>

          <div>
            <label
              htmlFor="dup-source"
              className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1 block"
            >
              Copy from
            </label>
            <select
              id="dup-source"
              aria-label="Copy from"
              value={sourceSlug}
              onChange={(e) => setSourceSlug(e.target.value)}
              className="w-full border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
            >
              {candidates.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name} ({p.slug})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="dup-slug"
              className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1 block"
            >
              New slug
            </label>
            <input
              id="dup-slug"
              aria-label="New slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="lowercase-with-dashes"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="w-full border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
            />
          </div>

          <div>
            <label
              htmlFor="dup-name"
              className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1 block"
            >
              New name
            </label>
            <input
              id="dup-name"
              aria-label="New name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              className="w-full border-b border-rule bg-transparent py-1 text-[18px] font-display focus:outline-none focus:border-ink"
            />
          </div>

          {error && (
            <p role="alert" className="text-accent-deep text-[12px]">
              {error}
            </p>
          )}

          <footer className="flex items-center justify-end gap-3 pt-2 border-t border-rule">
            <button
              type="button"
              onClick={onClose}
              disabled={mut.isPending}
              className="text-[12px] uppercase tracking-wider text-ink-faint hover:text-ink disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mut.isPending || !sourceSlug || !slug || !name}
              className="bg-ink text-paper px-4 py-2 text-[12px] tracking-wider uppercase disabled:opacity-40"
            >
              {mut.isPending ? "Duplicating…" : "Duplicate voice"}
            </button>
          </footer>
        </form>
      </div>
    </>
  );
}
