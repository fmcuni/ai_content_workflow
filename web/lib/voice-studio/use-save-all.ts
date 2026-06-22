"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { personasApi, promptsApi, sourcePolicyApi } from "@/lib/api";
import type { PromptTemplateSchema } from "@/lib/types";
import {
  isGlossaryDraft,
  isLocaleDraft,
  isPublishTargetDraft,
  isSourcePolicyDraft,
  type ConfigDraftKind,
} from "@/lib/voice-studio/draft-store";
import { useStudioDraft } from "@/lib/voice-studio/draft-store-provider";

/** 64 KiB per-template body cap — mirrors the editor + backend limit. */
const MAX_BYTES = 64 * 1024;

/** A dirty prompt draft that failed the client pre-validation gate. */
export interface PromptValidationError {
  templateId: string;
  /** Required placeholders absent from the draft body. */
  missingPlaceholders: string[];
  /** True when the body exceeds the 64 KiB cap. */
  tooLarge: boolean;
}

/** Per-item save outcome. Discriminated by `target` so the UI can label each
 * prompt-vs-config row and route conflicts to the right "reload" affordance. */
export type SaveItemResult =
  | { target: "prompt"; templateId: string; ok: true; sha256: string }
  | { target: "prompt"; templateId: string; ok: false; conflict: boolean; error: string }
  | { target: "config"; kind: ConfigDraftKind; ok: true }
  | { target: "config"; kind: ConfigDraftKind; ok: false; conflict: boolean; error: string };

/** Result of running Save-all. */
export interface SaveAllResult {
  /** Pre-validation failed → no network call was made. */
  validationErrors: PromptValidationError[];
  /** Per-item dispatch outcomes (empty when validation aborted). */
  items: SaveItemResult[];
  ok: number;
  total: number;
}

export interface UseSaveAll {
  /** Run the unified save. Resolves with a structured report. */
  saveAll: (batchNote?: string) => Promise<SaveAllResult>;
  /** True while a save is in flight. */
  isSaving: boolean;
}

// Contract: api.ts `http()` encodes HTTP failures as `new Error("<status>: <body>")`
// — there is no typed error class or status field to narrow against, so the status
// lives only as the message prefix. Match the leading "409" rather than a loose
// substring so a 409 in the response body can't masquerade as a conflict.
function isConflict(error: unknown): boolean {
  return error instanceof Error && /^409\b/.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Voice Studio unified "Save all". Validates every dirty prompt draft client-side
 * (required placeholders present, body ≤ 64 KiB) BEFORE any network call, then
 * dispatches each dirty item sequentially through its existing endpoint — prompt
 * drafts via the SHA-locked template PUT, config drafts via the persona /
 * source-policy writes. There is no batch endpoint and no false atomicity:
 * successful items are committed (draft cleared, queries invalidated) while
 * failed / conflicted items stay dirty and are reported per-item.
 *
 * Returns a no-op (and an empty report) when no Studio provider is mounted.
 */
export function useSaveAll(voice: string): UseSaveAll {
  const studio = useStudioDraft();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);

  async function validatePrompts(templateIds: string[]): Promise<PromptValidationError[]> {
    const errors: PromptValidationError[] = [];
    for (const templateId of templateIds) {
      const draft = studio?.state.prompts.get(templateId);
      if (!draft) continue;
      // Required-placeholder rules come from the same /schema endpoint the editor
      // reads (required_placeholders) — fetched (cache-first) so the gate uses the
      // exact rules the editor enforces today, not a re-derived copy.
      const schema = await queryClient.fetchQuery<PromptTemplateSchema>({
        queryKey: ["prompts", "schema", voice, templateId],
        queryFn: () => promptsApi.templateSchema(templateId, voice),
      });
      const missingPlaceholders = (schema.required_placeholders ?? []).filter(
        (name) => !draft.body.includes(`{${name}}`),
      );
      const tooLarge = new Blob([draft.body]).size > MAX_BYTES;
      if (missingPlaceholders.length > 0 || tooLarge) {
        errors.push({ templateId, missingPlaceholders, tooLarge });
      }
    }
    return errors;
  }

  async function savePrompt(
    templateId: string,
    batchNote: string | undefined,
  ): Promise<SaveItemResult> {
    const draft = studio!.state.prompts.get(templateId);
    if (!draft) {
      // Invariant violation: savePrompt is only called for ids in dirtyPromptIds,
      // so a missing draft is an internal bug, not a successful save. Report it as
      // a failure (not a conflict) so the item stays dirty and surfaces.
      return {
        target: "prompt",
        templateId,
        ok: false,
        conflict: false,
        error: "draft disappeared",
      };
    }
    try {
      const res = await promptsApi.saveTemplate(templateId, voice, {
        template: draft.body,
        expected_sha256: draft.baseSha,
        note: batchNote?.trim() || null,
      });
      studio!.commitPromptDraft(templateId, res.sha256);
      void queryClient.invalidateQueries({ queryKey: ["prompts", "template", voice, templateId] });
      void queryClient.invalidateQueries({ queryKey: ["prompts", "templates", voice] });
      void queryClient.invalidateQueries({ queryKey: ["prompts", "history", voice, templateId] });
      return { target: "prompt", templateId, ok: true, sha256: res.sha256 };
    } catch (error: unknown) {
      return {
        target: "prompt",
        templateId,
        ok: false,
        conflict: isConflict(error),
        error: errorMessage(error),
      };
    }
  }

  async function saveConfig(kind: ConfigDraftKind): Promise<SaveItemResult> {
    const value = studio!.state.config[kind];
    try {
      if (isLocaleDraft(value)) {
        await personasApi.update(voice, { locale: value.locale });
      } else if (isGlossaryDraft(value)) {
        await personasApi.update(voice, { glossary: value.glossary });
      } else if (isPublishTargetDraft(value)) {
        await personasApi.update(voice, { publish_target_id: value.publishTargetId });
      } else if (isSourcePolicyDraft(value)) {
        await sourcePolicyApi.save(voice, {
          policy: value.policy,
          expected_sha256: value.baseSha,
          // Config writes ignore the batch note (no note concept there).
        });
      } else {
        // Unknown / malformed draft — none of the type guards matched. Report a
        // failure and leave the draft dirty rather than silently clearing it.
        return { target: "config", kind, ok: false, conflict: false, error: "unrecognised draft kind" };
      }
      studio!.clearConfigDraft(kind);
      void queryClient.invalidateQueries({ queryKey: ["persona", voice] });
      void queryClient.invalidateQueries({ queryKey: ["personas"] });
      if (kind === "source_policy") {
        void queryClient.invalidateQueries({ queryKey: ["source-policy", voice] });
      }
      if (kind === "publish_target") {
        void queryClient.invalidateQueries({ queryKey: ["publish-targets", false] });
      }
      return { target: "config", kind, ok: true };
    } catch (error: unknown) {
      return {
        target: "config",
        kind,
        ok: false,
        conflict: isConflict(error),
        error: errorMessage(error),
      };
    }
  }

  async function saveAll(batchNote?: string): Promise<SaveAllResult> {
    if (!studio) {
      return { validationErrors: [], items: [], ok: 0, total: 0 };
    }
    const promptIds = studio.dirtyPromptIds;
    const configKinds = studio.dirtyConfigKinds;
    const total = promptIds.length + configKinds.length;

    setIsSaving(true);
    try {
      // 1) Pre-validation gate — abort before any network call on first failure set.
      const validationErrors = await validatePrompts(promptIds);
      if (validationErrors.length > 0) {
        return { validationErrors, items: [], ok: 0, total };
      }

      // 2) Sequential dispatch. Prompts first, then config.
      const items: SaveItemResult[] = [];
      for (const templateId of promptIds) {
        items.push(await savePrompt(templateId, batchNote));
      }
      for (const kind of configKinds) {
        items.push(await saveConfig(kind));
      }
      const ok = items.filter((i) => i.ok).length;
      return { validationErrors: [], items, ok, total };
    } finally {
      setIsSaving(false);
    }
  }

  return { saveAll, isSaving };
}
