"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { RoleButton } from "@/components/RoleGate";
import { Input } from "@/components/ui/input";
import { useRole } from "@/lib/use-role";
import { sourcePolicyApi } from "@/lib/api";
import type { SourcePolicyDoc } from "@/lib/types";

const EMPTY_DOC: SourcePolicyDoc = {
  deny: { domains: [], tlds: [] },
  prefer: { tlds: [], domains: [] },
  community_exception: { topic_categories: [], allowed_domains: [] },
};

function normalizeEntry(value: string): string {
  return value.trim().toLowerCase();
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Add/remove chip list for one string[] field. Edits are immutable. */
function ChipList({
  label,
  hint,
  items,
  placeholder,
  onChange,
}: {
  label: string;
  hint: string;
  items: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const value = normalizeEntry(draft);
    if (value.length === 0 || items.includes(value)) {
      setDraft("");
      return;
    }
    onChange([...items, value]);
    setDraft("");
  }

  function remove(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  return (
    <div className="border-b border-rule py-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="kicker">
          {label} <span className="text-ink">· {items.length}</span>
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {hint}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {items.length === 0 && (
          <span className="font-mono text-[12px] text-ink-faint">（未設定）</span>
        )}
        {items.map((item, i) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 rounded border border-rule bg-paper-deep/60 px-2 py-1 font-mono text-[12px] text-ink"
          >
            {item}
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => remove(i)}
              className="text-ink-faint hover:text-accent-deep transition-colors leading-none"
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className="font-mono text-[13px] max-w-[320px]"
        />
        <Button type="button" variant="outline" size="sm" onClick={add}>
          + add
        </Button>
      </div>
    </div>
  );
}

interface SourcePolicyEditorProps {
  /** Voice (persona slug) whose policy to edit. The policy is per-voice; a voice
   * without its own row resolves the shared seed (then bundled YAML) server-side. */
  voice: string;
}

export function SourcePolicyEditor({ voice }: SourcePolicyEditorProps) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["source-policy", voice],
    queryFn: () => sourcePolicyApi.get(voice),
  });
  const historyQ = useQuery({
    queryKey: ["source-policy", voice, "history"],
    queryFn: () => sourcePolicyApi.history(voice),
  });

  const [doc, setDoc] = useState<SourcePolicyDoc>(EMPTY_DOC);
  const [baseline, setBaseline] = useState<SourcePolicyDoc>(EMPTY_DOC);
  const [sha, setSha] = useState<string | null>(null);
  const [rendered, setRendered] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Editing source policy is admin-only (server-authoritative).
  const { can } = useRole();
  const canEditPolicy = can("edit_source_policy");

  // Seed local state from the server once (and after a save/revert reload, or a
  // voice switch). Syncing the editor buffer to the freshly fetched server copy
  // is the intended use here — see the matching pattern in the prompt editor.
  useEffect(() => {
    if (q.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDoc(q.data.policy);
      setBaseline(q.data.policy);
      setSha(q.data.sha256);
      setRendered(q.data.rendered);
    }
  }, [q.data]);

  const isDirty = useMemo(
    () => JSON.stringify(doc) !== JSON.stringify(baseline),
    [doc, baseline],
  );

  // Live preview: debounce edits, render the prompt block server-side so it
  // matches exactly what the writer agents inject.
  useEffect(() => {
    if (!isDirty) return;
    const handle = setTimeout(() => {
      sourcePolicyApi
        .preview(voice, doc)
        .then((r) => setRendered(r.rendered))
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(handle);
  }, [doc, isDirty, voice]);

  const saveMut = useMutation({
    mutationFn: () => {
      if (sha === null) throw new Error("policy not loaded yet");
      return sourcePolicyApi.save(voice, { policy: doc, expected_sha256: sha });
    },
    onSuccess: (res) => {
      setError(null);
      setBaseline(res.policy);
      setDoc(res.policy);
      setSha(res.sha256);
      setRendered(res.rendered);
      void queryClient.invalidateQueries({ queryKey: ["source-policy", voice] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.startsWith("409")
          ? "This policy was changed elsewhere since you loaded it. Reload before saving."
          : msg,
      );
    },
  });

  const revertMut = useMutation({
    mutationFn: (versionId: string) => {
      if (sha === null) throw new Error("policy not loaded yet");
      return sourcePolicyApi.revert(voice, { target_version_id: versionId, expected_sha256: sha });
    },
    onSuccess: (res) => {
      setError(null);
      setBaseline(res.policy);
      setDoc(res.policy);
      setSha(res.sha256);
      setRendered(res.rendered);
      void queryClient.invalidateQueries({ queryKey: ["source-policy", voice] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (q.isLoading) return <p className="text-ink-faint mt-6">Loading source policy…</p>;
  if (q.isError || !q.data) {
    return <p className="text-accent-deep text-[13px] mt-6">Failed to load source policy.</p>;
  }

  const versions = historyQ.data?.versions ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
      <div>
        <p className="font-mono text-[11px] text-ink-soft tracking-[0.02em] mb-4">
          {doc.deny.domains.length + doc.prefer.domains.length} domains ·{" "}
          {sha ? `sha ${shortSha(sha)}` : "—"}
          {isDirty && <span className="text-accent ml-2">· unsaved changes</span>}
        </p>

        <ChipList
          label="Denied domains"
          hint="Competitors / insurers — never cited"
          items={doc.deny.domains}
          placeholder="manulife.com.hk"
          onChange={(domains) => setDoc((d) => ({ ...d, deny: { ...d.deny, domains } }))}
        />
        <ChipList
          label="Denied TLDs"
          hint="Any source under these TLDs — never cited"
          items={doc.deny.tlds}
          placeholder=".cn"
          onChange={(tlds) => setDoc((d) => ({ ...d, deny: { ...d.deny, tlds } }))}
        />
        <ChipList
          label="Preferred TLDs"
          hint="Authority TLDs, ranked first"
          items={doc.prefer.tlds}
          placeholder=".gov.hk"
          onChange={(tlds) => setDoc((d) => ({ ...d, prefer: { ...d.prefer, tlds } }))}
        />
        <ChipList
          label="Preferred domains"
          hint="Authority institutions"
          items={doc.prefer.domains}
          placeholder="who.int"
          onChange={(domains) => setDoc((d) => ({ ...d, prefer: { ...d.prefer, domains } }))}
        />
        <ChipList
          label="Community categories"
          hint="topic_category values that allow community sources"
          items={doc.community_exception.topic_categories}
          placeholder="community-response"
          onChange={(topic_categories) =>
            setDoc((d) => ({
              ...d,
              community_exception: { ...d.community_exception, topic_categories },
            }))
          }
        />
        <ChipList
          label="Community domains"
          hint="Forums allowed only for the categories above"
          items={doc.community_exception.allowed_domains}
          placeholder="reddit.com"
          onChange={(allowed_domains) =>
            setDoc((d) => ({
              ...d,
              community_exception: { ...d.community_exception, allowed_domains },
            }))
          }
        />

        <div className="flex items-center gap-3 mt-6">
          <RoleButton
            need="edit_source_policy"
            deniedHint="Admin role required to edit the source policy."
            onClick={() => saveMut.mutate()}
            disabled={!isDirty || saveMut.isPending}
          >
            {saveMut.isPending ? "Saving…" : "Save policy"}
          </RoleButton>
          {isDirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setDoc(baseline);
                setError(null);
              }}
            >
              Discard changes
            </Button>
          )}
          {error && <span className="text-accent-deep text-[12px]">{error}</span>}
        </div>
      </div>

      <aside className="space-y-6">
        <div>
          <h3 className="kicker mb-2">Rendered block</h3>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint mb-2">
            Injected into writer prompts as {"{source_policy_block}"}
          </p>
          <pre className="whitespace-pre-wrap break-words border border-rule rounded bg-paper-deep/40 p-3 font-mono text-[12px] leading-relaxed text-ink-soft max-h-[420px] overflow-auto">
            {rendered}
          </pre>
        </div>

        <div>
          <h3 className="kicker mb-2">
            History <span className="text-ink">· {versions.length}</span>
          </h3>
          <ul className="border-t border-rule max-h-[280px] overflow-auto">
            {versions.map((v) => (
              <li
                key={v.version_id}
                className="border-b border-rule py-2 flex items-center justify-between gap-2"
              >
                <span className="font-mono text-[11px] text-ink-soft truncate">
                  {v.kind} · {shortSha(v.sha256)} · {v.saved_by}
                </span>
                <button
                  type="button"
                  disabled={revertMut.isPending || !canEditPolicy}
                  title={!canEditPolicy ? "Admin role required to revert the source policy." : undefined}
                  onClick={() => revertMut.mutate(v.version_id)}
                  className="font-sans text-[12px] font-medium text-accent hover:underline underline-offset-2 whitespace-nowrap disabled:opacity-50"
                >
                  Revert
                </button>
              </li>
            ))}
            {versions.length === 0 && (
              <li className="py-2 font-mono text-[11px] text-ink-faint">No edits yet.</li>
            )}
          </ul>
        </div>
      </aside>
    </div>
  );
}
