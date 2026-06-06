"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, use, useEffect, useMemo, useState } from "react";
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
import { promptsApi } from "@/lib/api";
import type { PromptVersionSummary } from "@/lib/types";
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
  const queryClient = useQueryClient();

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

  const [buffer, setBuffer] = useState<string>("");
  const [sha, setSha] = useState<string>("");
  const [activeRoute, setActiveRoute] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [openVersion, setOpenVersion] = useState<PromptVersionSummary | null>(null);

  // The server-loaded copy primes the buffer once per (template_id, sha)
  // pair; afterwards the buffer is the source of truth for the editor,
  // chip validation, and preview.
  useEffect(() => {
    if (templateQ.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBuffer(templateQ.data.template);
      setSha(templateQ.data.sha256 ?? "");
    }
  }, [templateQ.data]);

  // Default preview to the first consumer (= itself for agent prompts).
  useEffect(() => {
    if (consumersQ.data && activeRoute === null && consumersQ.data.consumers.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveRoute(consumersQ.data.consumers[0]);
    }
  }, [consumersQ.data, activeRoute]);

  const isPartial = templateQ.data?.category === "partial";

  const placeholderStatus = useMemo(() => {
    const required = schemaQ.data?.required_placeholders ?? [];
    return required.map((name) => ({
      name,
      present: buffer.includes(`{${name}}`),
    }));
  }, [buffer, schemaQ.data]);

  const missingPlaceholders = placeholderStatus.filter((p) => !p.present).map((p) => p.name);
  const isDirty = templateQ.data ? buffer !== templateQ.data.template : false;
  const tooLarge = new Blob([buffer]).size > 64 * 1024;
  const saveBlocked = !isDirty || missingPlaceholders.length > 0 || tooLarge;

  const previewMut = useMutation({
    mutationFn: async () => {
      if (!activeRoute) throw new Error("no route selected");
      const body: { template: string; route: string } = {
        template: buffer,
        route: activeRoute,
      };
      return promptsApi.previewTemplate(templateId, voice, body);
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
  useEffect(() => {
    if (!activeRoute || !buffer) return;
    const t = setTimeout(() => previewMut.mutate(), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoute, buffer]);

  const saveMut = useMutation({
    mutationFn: () =>
      promptsApi.saveTemplate(templateId, voice, {
        template: buffer,
        expected_sha256: sha,
      }),
    onSuccess: (data) => {
      toast.success("Saved · effect applies on next run");
      setSha(data.sha256);
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
      setBuffer("");
      await queryClient.invalidateQueries({
        queryKey: ["prompts", "template", voice, templateId],
      });
    },
  });

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <Link
        href="/prompts"
        className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint hover:text-accent inline-block mb-3"
      >
        ← Prompt Library
      </Link>

      <SectionHead
        kicker={
          <>
            {templateQ.data?.category === "partial" ? "Partial" : "Agent prompt"}
            {" · voice "}
            {voice}
            {templateQ.data?.voice_slug === "__shared__" ? " (shared default)" : null}
            {templateQ.data?.filename ? <> · {templateQ.data.filename}</> : null}
          </>
        }
        hed={templateId}
        dek={
          isPartial
            ? "This partial is slotted into the routes shown below. Edits affect every consumer route on the next run."
            : "Full system prompt. Edits take effect on the next run — running tasks keep their current copy."
        }
        actions={
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
        }
      />

      {templateQ.isLoading && <p className="text-ink-faint">Loading template…</p>}
      {templateQ.isError && (
        <p className="text-accent-deep text-[13px]">Failed to load template.</p>
      )}

      {templateQ.data && (
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
          <div>
            <h3 className="kicker mb-2">Source</h3>
            <textarea
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              value={buffer}
              onChange={(e) => setBuffer(e.target.value)}
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
                  No saves yet. The first save creates a version row you can
                  revert to.
                </p>
              )}
              {historyQ.data && historyQ.data.versions.length > 0 && (
                <ul className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
                  {historyQ.data.versions.map((v) => (
                    <li key={v.version_id}>
                      <button
                        type="button"
                        onClick={() => setOpenVersion(v)}
                        className="w-full text-left border border-rule hover:border-accent rounded-sm px-2 py-1.5 transition-colors group"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10.5px] text-ink-soft">
                            {relativeTime(v.saved_at)}
                          </span>
                          <span
                            className={cn(
                              "font-mono text-[10px] uppercase tracking-wider px-1 py-px rounded-sm",
                              v.kind === "revert"
                                ? "bg-accent/10 text-accent"
                                : "bg-paper-deep/50 text-ink-faint",
                            )}
                          >
                            {v.kind}
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-ink-faint mt-0.5 truncate">
                          {v.saved_by} · {v.sha256.slice(0, 7)}
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
            <pre className="font-mono text-[12px] leading-[1.55] text-ink-soft bg-paper-deep/30 border border-rule rounded-sm p-3 whitespace-pre-wrap max-h-[55vh] overflow-auto">
              {versionDetailQ.data.body}
            </pre>
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
