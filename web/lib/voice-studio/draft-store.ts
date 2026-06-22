/**
 * Voice Studio unsaved-draft store — pure reducer + types.
 *
 * Holds in-progress (unsaved) edits for a single voice while the operator works
 * across the Studio canvas: prompt-template buffers keyed by template id, plus
 * config drafts (locale / glossary / source policy / publish target). Per the
 * locked product decisions the store is per-session and cleared on leave — the
 * React provider owns that lifecycle; this module is React-free so the
 * transitions and derivations can be unit-tested in isolation.
 *
 * All updates are immutable: every action returns a new state with a fresh Map
 * / object — existing state is never mutated.
 */

import type { GlossaryEntry, SourcePolicyDoc, VoiceLocale } from "@/lib/types";

export type ConfigDraftKind = "locale" | "glossary" | "source_policy" | "publish_target";

// ---- Config draft value contracts ----------------------------------------
// Each config kind stores a typed value in `StudioDraftState.config`. The store
// itself keeps these as `unknown` (so the reducer stays kind-agnostic); panels
// write them and `useSaveAll` narrows them back via the type guards below. All
// three persona-backed kinds dispatch through a single whole-object persona
// PUT; `source_policy` dispatches through the source-policy PUT and therefore
// carries its own optimistic-lock sha + change note.

/** Locale draft → persona PUT `{ locale }`. */
export interface LocaleConfigDraft {
  kind: "locale";
  locale: VoiceLocale;
}

/** Glossary draft → persona PUT `{ glossary }`. */
export interface GlossaryConfigDraft {
  kind: "glossary";
  glossary: GlossaryEntry[];
}

/** Publish-target draft → persona PUT `{ publish_target_id }`. null clears it. */
export interface PublishTargetConfigDraft {
  kind: "publish_target";
  publishTargetId: string | null;
}

/** Source-policy draft → source-policy PUT (sha-locked, optional note). */
export interface SourcePolicyConfigDraft {
  kind: "source_policy";
  policy: SourcePolicyDoc;
  /** The sha the edit was started from — optimistic lock for the PUT. */
  baseSha: string;
}

export type ConfigDraftValue =
  | LocaleConfigDraft
  | GlossaryConfigDraft
  | PublishTargetConfigDraft
  | SourcePolicyConfigDraft;

export function isLocaleDraft(v: unknown): v is LocaleConfigDraft {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "locale";
}
export function isGlossaryDraft(v: unknown): v is GlossaryConfigDraft {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "glossary";
}
export function isPublishTargetDraft(v: unknown): v is PublishTargetConfigDraft {
  return (
    typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "publish_target"
  );
}
export function isSourcePolicyDraft(v: unknown): v is SourcePolicyConfigDraft {
  return (
    typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "source_policy"
  );
}

export interface PromptDraft {
  /** The in-progress template body. */
  body: string;
  /**
   * The server SHA the edit was started from — captured at the first edit for
   * optimistic-lock conflict detection on save. Stable across later edits of
   * the same draft.
   */
  baseSha: string;
}

export interface StudioDraftState {
  /** Dirty prompt buffers keyed by template id. Absence ⇒ not dirty. */
  prompts: Map<string, PromptDraft>;
  /** Dirty config drafts keyed by kind. Value is typed per kind by consumers. */
  config: Partial<Record<ConfigDraftKind, unknown>>;
}

export type DraftAction =
  | { type: "set-prompt-draft"; templateId: string; body: string; baseSha: string }
  | { type: "clear-prompt-draft"; templateId: string }
  | { type: "commit-prompt-draft"; templateId: string; baseSha: string }
  | { type: "set-config-draft"; kind: ConfigDraftKind; value: unknown }
  | { type: "clear-config-draft"; kind: ConfigDraftKind }
  | { type: "clear-all" };

/** A fresh, empty draft state. New instances each call — never shared. */
export function emptyStudioDraftState(): StudioDraftState {
  return { prompts: new Map(), config: {} };
}

function setPromptDraft(
  state: StudioDraftState,
  templateId: string,
  body: string,
  baseSha: string,
): StudioDraftState {
  const next = new Map(state.prompts);
  // baseSha is the optimistic lock captured at the FIRST edit; later edits keep it.
  const existing = next.get(templateId);
  next.set(templateId, { body, baseSha: existing?.baseSha ?? baseSha });
  return { ...state, prompts: next };
}

function clearPromptDraft(state: StudioDraftState, templateId: string): StudioDraftState {
  if (!state.prompts.has(templateId)) return state;
  const next = new Map(state.prompts);
  next.delete(templateId);
  return { ...state, prompts: next };
}

function setConfigDraft(
  state: StudioDraftState,
  kind: ConfigDraftKind,
  value: unknown,
): StudioDraftState {
  return { ...state, config: { ...state.config, [kind]: value } };
}

function clearConfigDraft(state: StudioDraftState, kind: ConfigDraftKind): StudioDraftState {
  if (!(kind in state.config)) return state;
  const next = { ...state.config };
  delete next[kind];
  return { ...state, config: next };
}

export function draftReducer(state: StudioDraftState, action: DraftAction): StudioDraftState {
  switch (action.type) {
    case "set-prompt-draft":
      return setPromptDraft(state, action.templateId, action.body, action.baseSha);
    case "clear-prompt-draft":
      return clearPromptDraft(state, action.templateId);
    case "commit-prompt-draft":
      // A committed prompt is now in sync with the server (its new baseSha) and
      // is no longer dirty — drop it from the dirty set.
      return clearPromptDraft(state, action.templateId);
    case "set-config-draft":
      return setConfigDraft(state, action.kind, action.value);
    case "clear-config-draft":
      return clearConfigDraft(state, action.kind);
    case "clear-all":
      return emptyStudioDraftState();
  }
}

// ---- Derivations ----------------------------------------------------------

export function selectDirtyPromptIds(state: StudioDraftState): string[] {
  return [...state.prompts.keys()];
}

export function selectDirtyConfigKinds(state: StudioDraftState): ConfigDraftKind[] {
  return Object.keys(state.config) as ConfigDraftKind[];
}

export function selectUnsavedCount(state: StudioDraftState): number {
  return state.prompts.size + Object.keys(state.config).length;
}
