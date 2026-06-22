import { describe, expect, it } from "vitest";

import {
  draftReducer,
  emptyStudioDraftState,
  selectDirtyConfigKinds,
  selectDirtyPromptIds,
  selectUnsavedCount,
  type StudioDraftState,
} from "@/lib/voice-studio/draft-store";

function withPromptDraft(): StudioDraftState {
  return draftReducer(emptyStudioDraftState(), {
    type: "set-prompt-draft",
    templateId: "writer",
    body: "edited body",
    baseSha: "sha-1",
  });
}

describe("draftReducer — prompt drafts", () => {
  it("captures the body and baseSha on first edit", () => {
    const state = withPromptDraft();
    expect(state.prompts.get("writer")).toEqual({ body: "edited body", baseSha: "sha-1" });
  });

  it("keeps the original baseSha on subsequent edits (lock captured at first edit)", () => {
    const first = withPromptDraft();
    const second = draftReducer(first, {
      type: "set-prompt-draft",
      templateId: "writer",
      body: "edited again",
      baseSha: "sha-2-IGNORED",
    });
    expect(second.prompts.get("writer")).toEqual({ body: "edited again", baseSha: "sha-1" });
  });

  it("produces a new Map instance (immutable update)", () => {
    const before = emptyStudioDraftState();
    const after = withPromptDraft();
    expect(after.prompts).not.toBe(before.prompts);
    expect(before.prompts.size).toBe(0);
  });

  it("clears a single prompt draft", () => {
    const state = draftReducer(withPromptDraft(), {
      type: "clear-prompt-draft",
      templateId: "writer",
    });
    expect(state.prompts.has("writer")).toBe(false);
  });

  it("updates baseSha and clears dirty for a committed prompt", () => {
    const state = draftReducer(withPromptDraft(), {
      type: "commit-prompt-draft",
      templateId: "writer",
      baseSha: "sha-committed",
    });
    // After commit the prompt is no longer dirty.
    expect(state.prompts.has("writer")).toBe(false);
    expect(selectDirtyPromptIds(state)).toEqual([]);
  });
});

describe("draftReducer — config drafts", () => {
  it("sets a config draft of a given kind", () => {
    const state = draftReducer(emptyStudioDraftState(), {
      type: "set-config-draft",
      kind: "locale",
      value: { output_language: "English" },
    });
    expect(state.config.locale).toEqual({ output_language: "English" });
  });

  it("clears a config draft", () => {
    const set = draftReducer(emptyStudioDraftState(), {
      type: "set-config-draft",
      kind: "glossary",
      value: [{ term: "x" }],
    });
    const cleared = draftReducer(set, { type: "clear-config-draft", kind: "glossary" });
    expect(cleared.config.glossary).toBeUndefined();
  });

  it("produces a new config object (immutable update)", () => {
    const before = emptyStudioDraftState();
    const after = draftReducer(before, {
      type: "set-config-draft",
      kind: "source_policy",
      value: { x: 1 },
    });
    expect(after.config).not.toBe(before.config);
    expect(before.config.source_policy).toBeUndefined();
  });
});

describe("draftReducer — clear-all", () => {
  it("discards every prompt and config draft", () => {
    let state = withPromptDraft();
    state = draftReducer(state, { type: "set-config-draft", kind: "locale", value: { a: 1 } });
    const cleared = draftReducer(state, { type: "clear-all" });
    expect(cleared.prompts.size).toBe(0);
    expect(Object.keys(cleared.config)).toEqual([]);
  });
});

describe("derivations — prompt + config coexist", () => {
  it("derives dirty sets and unsavedCount across both stores", () => {
    let state = withPromptDraft();
    state = draftReducer(state, {
      type: "set-prompt-draft",
      templateId: "outline",
      body: "o",
      baseSha: "sha-o",
    });
    state = draftReducer(state, { type: "set-config-draft", kind: "locale", value: { a: 1 } });
    state = draftReducer(state, { type: "set-config-draft", kind: "glossary", value: [] });

    expect(selectDirtyPromptIds(state).sort()).toEqual(["outline", "writer"]);
    expect(selectDirtyConfigKinds(state).sort()).toEqual(["glossary", "locale"]);
    // 2 prompts + 2 config kinds = 4
    expect(selectUnsavedCount(state)).toBe(4);
  });

  it("an empty state has zero unsaved count", () => {
    expect(selectUnsavedCount(emptyStudioDraftState())).toBe(0);
  });
});
