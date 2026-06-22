"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { SectionHead } from "@/components/SectionHead";
import { RoleButton } from "@/components/RoleGate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VersionDiff } from "@/components/VersionDiff";
import { promptsApi, type PreviewDraftInputs } from "@/lib/api";
import type { PromptVersionSummary } from "@/lib/types";
import {
  isGlossaryDraft,
  isLocaleDraft,
  isSourcePolicyDraft,
} from "@/lib/voice-studio/draft-store";
import { useStudioDraft } from "@/lib/voice-studio/draft-store-provider";
import { cn } from "@/lib/utils";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const MAX_BYTES = 64 * 1024;

interface PromptEditorProps {
  templateId: string;
  /** Per-voice library; a voice without its own copy falls back to the shared
   * seed server-side. The same id under a different voice is a different row. */
  voice: string;
  /** Inspector-docked layout: a tight inline header instead of the page
   * `SectionHead`, and a single stacked column (the lg: split collapses anyway
   * inside the narrow panel). Default false = the standalone library page. */
  compact?: boolean;
  /** Studio only: the in-editor Save button triggers the unified Save-all (Q5)
   * instead of a per-prompt PUT. Owned by the page so reporting + offender-jump
   * stay in one place. Ignored on the library page. */
  onStudioSave?: () => void;
  /** Studio only: true while a unified save is in flight (disables Save). */
  isStudioSaving?: boolean;
}

/**
 * The full prompt-management surface: edit + save (sha256 optimistic
 * concurrency) + assembled preview + read-only user-prompt / JSON-schema
 * references + version history with diff and revert. Used by both the
 * standalone `/prompts/[templateId]` library page and the Voice Studio
 * inspector so the two never drift.
 */
export function PromptEditor({
  templateId,
  voice,
  compact = false,
  onStudioSave,
  isStudioSaving = false,
}: PromptEditorProps) {
  const queryClient = useQueryClient();

  // Voice Studio draft store. Null on the standalone /prompts library page — in
  // that case the editor keeps its local-only buffer (zero behavior change). In
  // Studio the store is the source of truth so drafts survive node switches /
  // the inspector remounting a single PromptEditor across selections.
  const studio = useStudioDraft();
  const inStudio = studio !== null;

  const templateQ = useQuery({
    queryKey: ["prompts", "template", voice, templateId],
    queryFn: () => promptsApi.template(templateId, voice),
  });
  const schemaQ = useQuery({
    queryKey: ["prompts", "schema", voice, templateId],
    queryFn: () => promptsApi.templateSchema(templateId, voice),
  });
  const consumersQ = useQuery({
    queryKey: ["prompts", "consumers", voice, templateId],
    queryFn: () => promptsApi.templateConsumers(templateId, voice),
  });
  const historyQ = useQuery({
    queryKey: ["prompts", "history", voice, templateId],
    queryFn: () => promptsApi.templateHistory(templateId, voice),
  });

  // Local buffer is used ONLY in library mode. In Studio the body lives in the
  // shared store; `sha` (the latest server sha) is tracked locally in both modes
  // for reload + as the baseSha seed captured on the first Studio edit.
  const [localBuffer, setLocalBuffer] = useState<string>("");
  const [sha, setSha] = useState<string>("");
  const [activeRoute, setActiveRoute] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Optional one-line change reason recorded on the next save's version row.
  const [noteInput, setNoteInput] = useState<string>("");
  const [openVersion, setOpenVersion] = useState<PromptVersionSummary | null>(null);
  // The version dialog defaults to a diff against the current live body; the
  // toggle reveals the selected version's raw body.
  const [versionDiffMode, setVersionDiffMode] = useState(true);

  // The store draft for this template (Studio only). When present its body is
  // the displayed buffer and its baseSha is the optimistic lock; switching nodes
  // and coming back re-reads it, so edits are never wiped on remount.
  const studioDraft = studio?.state.prompts.get(templateId) ?? null;

  // Effective editor body. Studio: store draft body, else the server template
  // (so an unedited node shows the live copy). Library: the local buffer.
  const buffer = inStudio ? (studioDraft?.body ?? templateQ.data?.template ?? "") : localBuffer;

  // Reset the editor when the target template changes (the inspector reuses one
  // mounted instance across node selections). Without this, switching nodes
  // would briefly show the previous node's buffer until the query resolves.
  // In Studio the body itself lives in the store (not reset here) so drafts
  // survive the switch; only the transient per-node view state is cleared.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!inStudio) setLocalBuffer("");
    setSha("");
    setActiveRoute(null);
    setPreviewText("");
    setPreviewError(null);
    setNoteInput("");
  }, [templateId, voice, inStudio]);

  // The server-loaded copy primes the buffer once per (template_id, sha) pair.
  // Library: seeds the local buffer. Studio: only tracks the server sha — the
  // body is owned by the store, and an existing draft is left untouched.
  useEffect(() => {
    if (templateQ.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!inStudio) setLocalBuffer(templateQ.data.template);
      setSha(templateQ.data.sha256 ?? "");
    }
  }, [templateQ.data, inStudio]);

  // Write an edit to the right place: store in Studio (capturing the current
  // server sha as the baseSha on the first edit), local state in library mode.
  const onBufferChange = (value: string) => {
    if (studio) {
      // baseSha is the optimistic lock captured on the FIRST edit (later edits keep
      // it). Don't seed a draft with an empty sha — that would lock baseSha="" and
      // trigger a spurious 409 on save. Once a draft exists its baseSha is already
      // captured, so further edits are safe even before the query re-resolves.
      const hasDraft = studio.state.prompts.has(templateId);
      if (sha !== "" || hasDraft) {
        studio.setPromptDraft(templateId, value, sha);
      }
    } else {
      setLocalBuffer(value);
    }
  };

  // Default preview to the first consumer (= itself for agent prompts).
  useEffect(() => {
    if (consumersQ.data && activeRoute === null && consumersQ.data.consumers.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveRoute(consumersQ.data.consumers[0]);
    }
  }, [consumersQ.data, activeRoute]);

  const isPartial = templateQ.data?.category === "partial";

  // Read-only references served by /templates/:id/schema — the user-prompt
  // shape the agent sends alongside this system prompt, and the Gemini
  // responseSchema it must answer in. Both null for partials.
  const userPromptTemplate = schemaQ.data?.user_prompt_template ?? null;
  const responseSchema = schemaQ.data?.response_json_schema ?? null;

  const placeholderStatus = useMemo(() => {
    const required = schemaQ.data?.required_placeholders ?? [];
    return required.map((name) => ({
      name,
      present: buffer.includes(`{${name}}`),
    }));
  }, [buffer, schemaQ.data]);

  const missingPlaceholders = placeholderStatus.filter((p) => !p.present).map((p) => p.name);
  // Studio: dirty iff a store draft exists whose body differs from the server.
  // Library: dirty iff the local buffer differs from the server template.
  const isDirty = inStudio
    ? studioDraft !== null && templateQ.data !== undefined && studioDraft.body !== templateQ.data.template
    : templateQ.data
      ? buffer !== templateQ.data.template
      : false;
  const tooLarge = new Blob([buffer]).size > MAX_BYTES;
  const saveBlocked = !isDirty || missingPlaceholders.length > 0 || tooLarge;

  // Unsaved-draft inputs sent with the preview so the assembled output reflects
  // the operator's other in-progress edits (Studio only). `partial_overrides`
  // excludes the focused template id (it is sent as `template`, which wins).
  // Config drafts (locale / glossary / source policy) reflect live too. Library
  // mode sends nothing extra → byte-identical to the previous behavior.
  const previewDraftInputs = useMemo<PreviewDraftInputs>(() => {
    const state = studio?.state;
    if (!state) return {};
    const inputs: PreviewDraftInputs = {};
    const partialOverrides: Record<string, string> = {};
    for (const [id, draft] of state.prompts) {
      if (id !== templateId) partialOverrides[id] = draft.body;
    }
    if (Object.keys(partialOverrides).length > 0) inputs.partial_overrides = partialOverrides;

    const localeDraft = state.config.locale;
    if (isLocaleDraft(localeDraft)) inputs.locale = localeDraft.locale;
    const glossaryDraft = state.config.glossary;
    if (isGlossaryDraft(glossaryDraft)) inputs.glossary = glossaryDraft.glossary;
    const policyDraft = state.config.source_policy;
    if (isSourcePolicyDraft(policyDraft)) inputs.source_policy = policyDraft.policy;
    return inputs;
    // Depend on `studio?.state` (the reducer's state object — a new reference only
    // when the reducer produced new state) rather than `studio` (the context
    // wrapper, which gets a fresh identity on every dispatch). This re-derives on
    // any draft edit but not on unrelated re-renders.
  }, [studio?.state, templateId]);

  const previewMut = useMutation({
    mutationFn: async () => {
      if (!activeRoute) throw new Error("no route selected");
      return promptsApi.previewTemplate(templateId, voice, {
        template: buffer,
        route: activeRoute,
        ...previewDraftInputs,
      });
    },
    onSuccess: (data) => {
      setPreviewText(data.resolved);
      setPreviewError(null);
    },
    onError: (e: Error) => {
      setPreviewError(e.message);
      setPreviewText("");
    },
  });

  // Auto-preview on route change or after buffer settles (600 ms debounce).
  // previewMut is intentionally excluded from deps: its object identity changes
  // every render, so including it would re-fire the effect each render. The
  // route/buffer changes are the real triggers, and each run captures a fresh
  // previewMut closure, so there's no stale-mutation risk.
  useEffect(() => {
    if (!activeRoute || !buffer) return;
    const t = setTimeout(() => previewMut.mutate(), 600);
    return () => clearTimeout(t);
    // previewDraftInputs is included so a sibling partial / config draft edit
    // re-runs the preview, not just edits to the focused buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoute, buffer, previewDraftInputs]);

  const saveMut = useMutation({
    mutationFn: () =>
      promptsApi.saveTemplate(templateId, voice, {
        template: buffer,
        expected_sha256: sha,
        note: noteInput.trim() || null,
      }),
    onSuccess: (data) => {
      toast.success("Saved · effect applies on next run");
      setSha(data.sha256);
      setNoteInput("");
      queryClient.invalidateQueries({ queryKey: ["prompts", "template", voice, templateId] });
      queryClient.invalidateQueries({ queryKey: ["prompts", "templates", voice] });
      queryClient.invalidateQueries({ queryKey: ["prompts", "history", voice, templateId] });
    },
    onError: (e: Error) => {
      if (e.message.includes("409")) {
        toast.error(
          "Someone else saved this template since you loaded it. Reload to merge.",
        );
      } else {
        toast.error(`Save failed — ${e.message}`);
      }
    },
  });

  const revertMut = useMutation({
    mutationFn: async (target: PromptVersionSummary) => {
      // Always fetch the version body — both to show it in the dialog AND
      // to defend against the row being deleted before we POST revert.
      const detail = await promptsApi.templateVersion(templateId, voice, target.version_id);
      return promptsApi.revertTemplate(templateId, voice, {
        target_version_id: detail.version_id,
        expected_sha256: sha,
      });
    },
    onSuccess: (data) => {
      toast.success("Reverted · next run will use this body");
      setSha(data.sha256);
      setOpenVersion(null);
      queryClient.invalidateQueries({ queryKey: ["prompts", "template", voice, templateId] });
      queryClient.invalidateQueries({ queryKey: ["prompts", "templates", voice] });
      queryClient.invalidateQueries({ queryKey: ["prompts", "history", voice, templateId] });
    },
    onError: (e: Error) => {
      if (e.message.includes("409")) {
        toast.error(
          "Someone else saved this template since you loaded it. Reload to merge.",
        );
      } else {
        toast.error(`Revert failed — ${e.message}`);
      }
    },
  });

  const versionDetailQ = useQuery({
    queryKey: ["prompts", "version", voice, templateId, openVersion?.version_id],
    queryFn: () =>
      promptsApi.templateVersion(templateId, voice, openVersion!.version_id),
    enabled: openVersion !== null,
  });

  const reloadMut = useMutation({
    mutationFn: async () => {
      setLocalBuffer("");
      await queryClient.invalidateQueries({
        queryKey: ["prompts", "template", voice, templateId],
      });
    },
  });

  // Studio: unified Save-all (Q5) + a per-node "revert this draft". Library:
  // the original per-prompt Reload + SHA-locked Save.
  const actions =
    inStudio && studio ? (
      <div className="flex items-center gap-3">
        {isDirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => studio.clearPromptDraft(templateId)}
            disabled={isStudioSaving}
            title="Discard this node's unsaved edit"
          >
            Revert draft
          </Button>
        )}
        <RoleButton
          need="edit_prompts"
          deniedHint="Admin role required to edit prompts."
          size="sm"
          onClick={() => onStudioSave?.()}
          disabled={saveBlocked || isStudioSaving || !onStudioSave}
        >
          {isStudioSaving ? "Saving…" : "Save all"}
        </RoleButton>
      </div>
    ) : (
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => reloadMut.mutate()}
          disabled={saveMut.isPending || reloadMut.isPending}
        >
          {reloadMut.isPending ? "Reloading…" : "Reload"}
        </Button>
        <RoleButton
          need="edit_prompts"
          deniedHint="Admin role required to edit prompts."
          size="sm"
          onClick={() => saveMut.mutate()}
          disabled={saveBlocked || saveMut.isPending}
        >
          {saveMut.isPending ? "Saving…" : "Save"}
        </RoleButton>
      </div>
    );

  const kicker = (
    <>
      {templateQ.data?.category === "partial" ? "Partial" : "Agent prompt"}
      {" · voice "}
      {voice}
      {templateQ.data?.voice_slug === "__shared__" ? " (shared default)" : null}
      {templateQ.data?.filename ? <> · {templateQ.data.filename}</> : null}
    </>
  );

  return (
    <div>
      {compact ? (
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-rule">
          <div className="min-w-0">
            <p className="kicker truncate">{kicker}</p>
            <h2 className="font-display text-[18px] text-ink truncate">{templateId}</h2>
          </div>
          {actions}
        </div>
      ) : (
        <SectionHead
          kicker={kicker}
          hed={templateId}
          dek={
            isPartial
              ? "This partial is slotted into the routes shown below. Edits affect every consumer route on the next run."
              : "Full system prompt. Edits take effect on the next run — running tasks keep their current copy."
          }
          actions={actions}
        />
      )}

      {templateQ.isLoading && <p className="text-ink-faint mt-4">Loading template…</p>}
      {templateQ.isError && (
        <p className="text-accent-deep text-[13px] mt-4">Failed to load template.</p>
      )}

      {templateQ.data && (
        <div
          className={cn(
            "mt-4 grid grid-cols-1 gap-6",
            compact ? "" : "lg:grid-cols-[1fr_280px]",
          )}
        >
          <div>
            <h3 className="kicker mb-2">Source</h3>
            <textarea
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              value={buffer}
              onChange={(e) => onBufferChange(e.target.value)}
              className="w-full font-mono text-[12.5px] leading-[1.55] text-ink bg-paper-deep/30 border border-rule rounded-sm p-3 outline-none focus-visible:border-accent resize-y min-h-[420px]"
              style={{ tabSize: 2 }}
            />
            <p className="font-mono text-[10.5px] text-ink-faint mt-2">
              {new Blob([buffer]).size.toLocaleString()} / 65,536 bytes · sha {sha.slice(0, 7)}
              {isDirty ? <span className="text-accent ml-2">· modified</span> : null}
              {tooLarge ? (
                <span className="text-accent-deep ml-2">· exceeds 64 KiB</span>
              ) : null}
            </p>
            <input
              type="text"
              value={noteInput}
              maxLength={500}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Optional change note — why this edit (saved to history)"
              className="mt-2 w-full font-mono text-[11.5px] text-ink bg-paper-deep/30 border border-rule rounded-sm px-2.5 py-1.5 outline-none focus-visible:border-accent placeholder:text-ink-faint"
            />
          </div>

          <aside className="space-y-6">
            <div>
              <h3 className="kicker mb-2">Required placeholders</h3>
              {placeholderStatus.length === 0 ? (
                <p className="text-ink-faint text-[12px]">None.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {placeholderStatus.map((p) => (
                    <li
                      key={p.name}
                      className={cn(
                        "font-mono text-[10.5px] border rounded-sm px-1.5 py-0.5",
                        p.present
                          ? "text-ink-soft border-rule bg-paper-deep/40"
                          : "text-accent-deep border-accent-deep bg-rose-50",
                      )}
                      title={p.present ? "present" : "missing — save blocked"}
                    >
                      {`{${p.name}}`}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {schemaQ.data?.voice_locale && (
              <div>
                <h3 className="kicker mb-2">Voice locale</h3>
                <p className="text-ink-faint text-[11px] mb-2 leading-snug">
                  What this voice’s tokens resolve to at runtime (shown assembled
                  in the preview below).
                </p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {(
                    [
                      ["{brand_name}", schemaQ.data.voice_locale.brand_name],
                      ["{output_language}", schemaQ.data.voice_locale.output_language],
                      ["{market}", schemaQ.data.voice_locale.market],
                      ["{faq_heading}", schemaQ.data.voice_locale.faq_heading],
                      [
                        "{sources_heading}",
                        schemaQ.data.voice_locale.sources_heading ?? "auto · by script",
                      ],
                    ] as const
                  ).map(([token, value]) => (
                    <Fragment key={token}>
                      <dt className="font-mono text-[10.5px] text-ink-faint whitespace-nowrap">
                        {token}
                      </dt>
                      <dd className="font-mono text-[11px] text-ink-soft break-words">
                        {value}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            )}

            {schemaQ.data && schemaQ.data.found_includes.length > 0 && (
              <div>
                <h3 className="kicker mb-2">Includes</h3>
                <ul className="space-y-1">
                  {schemaQ.data.found_includes.map((name) => (
                    <li key={name} className="font-mono text-[11px]">
                      <Link
                        href={`/prompts/${name}?voice=${encodeURIComponent(voice)}`}
                        className="text-accent hover:underline"
                      >
                        {`{{include:${name}}}`}
                      </Link>
                      {schemaQ.data.unknown_includes.includes(name) ? (
                        <span className="text-accent-deep ml-1">· missing</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isPartial && consumersQ.data && (
              <div>
                <h3 className="kicker mb-2">Used by</h3>
                <ul className="space-y-1">
                  {consumersQ.data.consumers.map((id) => (
                    <li key={id} className="font-mono text-[11px]">
                      <Link
                        href={`/prompts/${id}?voice=${encodeURIComponent(voice)}`}
                        className="text-accent hover:underline"
                      >
                        {id}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h3 className="kicker mb-2">History</h3>
              {historyQ.isPending && (
                <p className="text-ink-faint text-[12px]">Loading…</p>
              )}
              {historyQ.data && historyQ.data.versions.length === 0 && (
                <p className="text-ink-faint text-[12px]">
                  No history yet.
                </p>
              )}
              {historyQ.data && historyQ.data.versions.length > 0 && (
                <ul className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
                  {historyQ.data.versions.map((v) => (
                    <li key={v.version_id}>
                      <button
                        type="button"
                        onClick={() => setOpenVersion(v)}
                        className={cn(
                          "w-full text-left border rounded-sm px-2 py-1.5 transition-colors group",
                          v.is_current
                            ? "border-accent bg-accent/5"
                            : "border-rule hover:border-accent",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10.5px] text-ink-soft tabular-nums">
                            v{v.version_number} · {relativeTime(v.saved_at)}
                          </span>
                          <span className="flex items-center gap-1">
                            {v.is_current && (
                              <span className="font-mono text-[10px] uppercase tracking-wider px-1 py-px rounded-sm bg-accent/15 text-accent">
                                ● Live
                              </span>
                            )}
                            <span
                              className={cn(
                                "font-mono text-[10px] uppercase tracking-wider px-1 py-px rounded-sm",
                                v.kind === "revert"
                                  ? "bg-accent/10 text-accent"
                                  : v.kind === "seed"
                                    ? "bg-info/10 text-info"
                                    : "bg-paper-deep/50 text-ink-faint",
                              )}
                            >
                              {v.kind}
                            </span>
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-ink-faint mt-0.5 truncate">
                          {v.saved_by} · {v.sha256.slice(0, 7)}
                          {v.note ? ` · ${v.note}` : ""}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}

      {consumersQ.data && consumersQ.data.consumers.length > 0 && (
        <section className="mt-10">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="kicker">
              Preview · assembled system prompt
            </h3>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              live values · {previewMut.isPending ? "rendering…" : "auto-refreshed"}
            </span>
          </div>
          {consumersQ.data.consumers.length > 1 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {consumersQ.data.consumers.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveRoute(id)}
                  className={cn(
                    "font-mono text-[11px] border rounded-sm px-2 py-1 transition-colors",
                    id === activeRoute
                      ? "border-accent text-accent bg-accent/5"
                      : "border-rule text-ink-soft hover:text-ink",
                  )}
                >
                  {id}
                </button>
              ))}
            </div>
          )}
          {previewError ? (
            <pre className="font-mono text-[12px] text-accent-deep bg-rose-50 border border-accent-deep rounded-sm p-3 whitespace-pre-wrap">
              {previewError}
            </pre>
          ) : (
            <pre className="font-mono text-[12px] leading-[1.55] text-ink-soft bg-paper-deep/30 border border-rule rounded-sm p-3 whitespace-pre-wrap max-h-[600px] overflow-auto">
              {previewText || (previewMut.isPending ? "Rendering…" : "")}
            </pre>
          )}
        </section>
      )}

      {(userPromptTemplate !== null || responseSchema !== null) && (
        <section
          className={cn(
            "mt-10 grid grid-cols-1 gap-6",
            compact ? "" : "lg:grid-cols-2",
          )}
        >
          {userPromptTemplate !== null && (
            <div>
              <div className="flex items-baseline justify-between mb-3 gap-3">
                <h3 className="kicker">Reference · user prompt</h3>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint text-right">
                  sent with this system prompt each run · read-only
                </span>
              </div>
              <pre className="font-mono text-[11.5px] leading-[1.55] text-ink-soft bg-paper-deep/30 border border-rule rounded-sm p-3 whitespace-pre-wrap max-h-[420px] overflow-auto">
                {userPromptTemplate}
              </pre>
              <p className="font-mono text-[10.5px] text-ink-faint mt-2">
                {"{placeholders}"} are filled from the run; “← only when …” lines are conditional.
              </p>
            </div>
          )}
          {responseSchema !== null && (
            <div>
              <div className="flex items-baseline justify-between mb-3 gap-3">
                <h3 className="kicker">Reference · output JSON schema</h3>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint text-right">
                  Gemini responseSchema · read-only
                </span>
              </div>
              <pre className="font-mono text-[11.5px] leading-[1.55] text-ink-soft bg-paper-deep/30 border border-rule rounded-sm p-3 whitespace-pre max-h-[420px] overflow-auto">
                {JSON.stringify(responseSchema, null, 2)}
              </pre>
              <p className="font-mono text-[10.5px] text-ink-faint mt-2">
                The model is forced to answer in this structure — prompt edits cannot change it.
              </p>
            </div>
          )}
        </section>
      )}

      <Dialog
        open={openVersion !== null}
        onOpenChange={(o) => { if (!o) setOpenVersion(null); }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {openVersion?.kind === "revert" ? "Revert" : "Save"}
              {" · "}
              {openVersion ? relativeTime(openVersion.saved_at) : ""}
            </DialogTitle>
            <DialogDescription>
              {openVersion ? (
                <>
                  Saved by {openVersion.saved_by} · sha{" "}
                  {openVersion.sha256.slice(0, 7)} · {openVersion.bytes.toLocaleString()} bytes.
                  Reverting overwrites the current file and creates a new
                  history row.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          {versionDetailQ.isPending && (
            <p className="text-ink-faint text-[12px]">Loading body…</p>
          )}
          {versionDetailQ.isError && (
            <p className="text-accent-deep text-[12px]">
              Failed to load — {(versionDetailQ.error as Error).message}
            </p>
          )}
          {versionDetailQ.data && (
            <>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setVersionDiffMode(true)}
                  className={cn(
                    "font-mono text-[10.5px] uppercase tracking-wider border rounded-sm px-2 py-0.5 transition-colors",
                    versionDiffMode
                      ? "border-accent text-accent bg-accent/5"
                      : "border-rule text-ink-soft hover:text-ink",
                  )}
                >
                  Diff vs current
                </button>
                <button
                  type="button"
                  onClick={() => setVersionDiffMode(false)}
                  className={cn(
                    "font-mono text-[10.5px] uppercase tracking-wider border rounded-sm px-2 py-0.5 transition-colors",
                    !versionDiffMode
                      ? "border-accent text-accent bg-accent/5"
                      : "border-rule text-ink-soft hover:text-ink",
                  )}
                >
                  Raw body
                </button>
              </div>
              {versionDiffMode ? (
                <VersionDiff
                  before={versionDetailQ.data.body}
                  after={templateQ.data?.template ?? ""}
                  className="p-0 max-h-[55vh]"
                  emptyLabel="This is the current live body — no differences."
                />
              ) : (
                <pre className="font-mono text-[12px] leading-[1.55] text-ink-soft bg-paper-deep/30 border border-rule rounded-sm p-3 whitespace-pre-wrap max-h-[55vh] overflow-auto">
                  {versionDetailQ.data.body}
                </pre>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOpenVersion(null)}
              disabled={revertMut.isPending}
            >
              Close
            </Button>
            <RoleButton
              need="edit_prompts"
              deniedHint="Admin role required to revert prompts."
              size="sm"
              onClick={() => { if (openVersion) revertMut.mutate(openVersion); }}
              disabled={
                !openVersion ||
                revertMut.isPending ||
                openVersion.sha256 === sha
              }
              title={
                openVersion?.sha256 === sha
                  ? "Already the current body"
                  : undefined
              }
            >
              {revertMut.isPending ? "Reverting…" : "Revert to this"}
            </RoleButton>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
