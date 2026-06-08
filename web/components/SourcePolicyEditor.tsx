"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { RoleButton } from "@/components/RoleGate";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRole } from "@/lib/use-role";
import { sourcePolicyApi } from "@/lib/api";
import type { SourcePolicyDoc } from "@/lib/types";

const EMPTY_DOC: SourcePolicyDoc = {
  deny: { domains: [], tlds: [] },
  prefer: { tlds: [], domains: [] },
  community_exception: { topic_categories: [], allowed_domains: [] },
};

// Tokens the server fills from the structured lists when rendering a template.
const POLICY_TOKENS = [
  "{prefer_tlds}",
  "{prefer_domains}",
  "{community_categories}",
  "{community_domains}",
  "{denied_tlds}",
  "{denied_tlds_line}",
] as const;

// Convenience seed for the template editor — mirrors the default rendered block
// with its dynamic bits left as tokens. Editing this never affects runtime
// unless saved; an empty template falls back to the same default server-side.
const DEFAULT_TEMPLATE = `引用與資料來源規則（由 source_policy 統一管理）：
- 主動使用 googleSearch 與 urlContext 工具核實時間敏感資訊（年份、收費、政策、法規、資格、流程、醫療或保險條款）。
- 你需要自行判斷並篩選「真確、權威」的資料來源，而不是機械式比對清單。評估每個來源時，請依下列原則排序取捨：
  1. 權威性：官方、政府、學術、法定機構或國際衛生組織等具公信力的一手來源優先。
  2. 一手原則：盡量引用發出資訊的原始機構，而非二手轉述或內容農場，或任何保險機構。
  3. 香港相關性與時效：優先採用適用於香港、且為最新版本的資料。
  4. 可信中立：避免無署名、無法核實、明顯 SEO 拼湊或商業推銷性質的來源。
- 高度建議優先採用（例子，非窮舉清單）：TLD {prefer_tlds}；機構 {prefer_domains}。若有更權威、更貼題的官方一手來源，亦可採用。
- 硬性禁止：不可引用 bowtie.com.hk 或任何保險公司網站作為資料來源。
{denied_tlds_line}
- 社區來源例外：只有當 topic_category 屬於「{community_categories}」時，方可引用社區／論壇來源（例如 {community_domains}）；其他題材一律不可引用社區來源。
- 引用必須在文中自然 ground 到具體段落，不可堆砌或泛泛而引。
- 不要在 markup 中手寫 \`## 資訊來源\` 區塊；該區塊由後處理流程根據 grounding metadata 自動生成。`;

/** Immutable update: set the template, or drop the key entirely when cleared so
 * the doc matches a freshly-loaded baseline (which has no key when unset). */
function withPromptBlock(doc: SourcePolicyDoc, value: string): SourcePolicyDoc {
  const next = { ...doc };
  if (value.length === 0) {
    delete next.prompt_block;
  } else {
    next.prompt_block = value;
  }
  return next;
}

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

        <div className="border-b border-rule py-4">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="kicker">Prompt block template</h3>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              Overrides the rendered prose · empty = default
            </span>
          </div>
          <p className="font-mono text-[11px] text-ink-soft leading-relaxed mb-2">
            Edit the full block. These tokens fill from the lists above:{" "}
            {POLICY_TOKENS.map((t) => (
              <span key={t} className="text-accent">
                {t}{" "}
              </span>
            ))}
          </p>
          <Textarea
            value={doc.prompt_block ?? ""}
            placeholder="Leave empty to use the default block. Click “Load default” to start from it."
            onChange={(e) => setDoc((d) => withPromptBlock(d, e.target.value))}
            disabled={!canEditPolicy}
            spellCheck={false}
            className="font-mono text-[12px] leading-relaxed min-h-[200px]"
          />
          <div className="flex gap-2 mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canEditPolicy}
              onClick={() => setDoc((d) => withPromptBlock(d, DEFAULT_TEMPLATE))}
            >
              Load default
            </Button>
            {(doc.prompt_block ?? "").length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canEditPolicy}
                onClick={() => setDoc((d) => withPromptBlock(d, ""))}
              >
                Clear (use default)
              </Button>
            )}
          </div>
        </div>

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
                <span className="font-mono text-[11px] text-ink-soft truncate flex items-center gap-1.5">
                  <span className="tabular-nums">v{v.version_number}</span>
                  {v.is_current && (
                    <span className="uppercase tracking-wider text-[10px] px-1 py-px rounded-sm bg-accent/15 text-accent">
                      ● Live
                    </span>
                  )}
                  <span>{v.kind} · {shortSha(v.sha256)} · {v.saved_by}</span>
                </span>
                <button
                  type="button"
                  disabled={revertMut.isPending || !canEditPolicy || v.is_current}
                  title={
                    v.is_current
                      ? "This is the live version."
                      : !canEditPolicy
                        ? "Admin role required to revert the source policy."
                        : undefined
                  }
                  onClick={() => revertMut.mutate(v.version_id)}
                  className="font-sans text-[12px] font-medium text-accent hover:underline underline-offset-2 whitespace-nowrap disabled:opacity-50"
                >
                  Revert
                </button>
              </li>
            ))}
            {versions.length === 0 && (
              <li className="py-2 font-mono text-[11px] text-ink-faint">No history yet.</li>
            )}
          </ul>
        </div>
      </aside>
    </div>
  );
}
