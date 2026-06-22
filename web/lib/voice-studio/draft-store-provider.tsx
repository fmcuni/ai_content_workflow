"use client";

import { createContext, useContext, useMemo, useReducer } from "react";
import type { ReactNode } from "react";

import {
  type ConfigDraftKind,
  type DraftAction,
  type StudioDraftState,
  draftReducer,
  emptyStudioDraftState,
  selectDirtyConfigKinds,
  selectDirtyPromptIds,
  selectUnsavedCount,
} from "@/lib/voice-studio/draft-store";

export interface UseStudioDraft {
  /** The current draft state for the active voice. */
  state: StudioDraftState;
  /** Set/replace a prompt draft. baseSha is captured at the first edit. */
  setPromptDraft: (templateId: string, body: string, baseSha: string) => void;
  /** Discard a single prompt draft. */
  clearPromptDraft: (templateId: string) => void;
  /** Mark a prompt as saved (clears its dirty flag) at the committed baseSha. */
  commitPromptDraft: (templateId: string, baseSha: string) => void;
  /** Set/replace a config draft of the given kind. */
  setConfigDraft: (kind: ConfigDraftKind, value: unknown) => void;
  /** Discard a single config draft. */
  clearConfigDraft: (kind: ConfigDraftKind) => void;
  /** Discard every draft for the active voice. */
  clearAll: () => void;
  /** Template ids with an unsaved prompt draft. */
  dirtyPromptIds: string[];
  /** Config kinds with an unsaved draft. */
  dirtyConfigKinds: ConfigDraftKind[];
  /** Total unsaved items (dirty prompts + dirty config kinds). */
  unsavedCount: number;
}

const StudioDraftContext = createContext<UseStudioDraft | null>(null);

interface StudioDraftProviderProps {
  /**
   * The active voice slug. The per-voice reset is handled by remounting this
   * provider with `key={slug}` at the mount site (which resets `useReducer` to
   * initial state) — not by any render-phase state mutation here.
   */
  voice: string;
  children: ReactNode;
}

export function StudioDraftProvider({ children }: StudioDraftProviderProps) {
  const [state, dispatch] = useReducer(draftReducer, undefined, emptyStudioDraftState);

  const value = useMemo<UseStudioDraft>(() => {
    const run = (action: DraftAction) => dispatch(action);
    return {
      state,
      setPromptDraft: (templateId, body, baseSha) =>
        run({ type: "set-prompt-draft", templateId, body, baseSha }),
      clearPromptDraft: (templateId) => run({ type: "clear-prompt-draft", templateId }),
      commitPromptDraft: (templateId, baseSha) =>
        run({ type: "commit-prompt-draft", templateId, baseSha }),
      setConfigDraft: (kind, configValue) =>
        run({ type: "set-config-draft", kind, value: configValue }),
      clearConfigDraft: (kind) => run({ type: "clear-config-draft", kind }),
      clearAll: () => run({ type: "clear-all" }),
      dirtyPromptIds: selectDirtyPromptIds(state),
      dirtyConfigKinds: selectDirtyConfigKinds(state),
      unsavedCount: selectUnsavedCount(state),
    };
  }, [state]);

  return <StudioDraftContext.Provider value={value}>{children}</StudioDraftContext.Provider>;
}

/**
 * Read/write the Voice Studio draft store. Returns null when no provider is
 * mounted (e.g. the `/prompts` library page) so consumers can fall back to
 * their local-only state path with zero behavior change.
 */
export function useStudioDraft(): UseStudioDraft | null {
  return useContext(StudioDraftContext);
}
