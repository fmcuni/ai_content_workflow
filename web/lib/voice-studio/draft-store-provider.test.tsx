import { describe, expect, it } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { StudioDraftProvider, useStudioDraft } from "@/lib/voice-studio/draft-store-provider";

function wrapperFor(voice: string) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <StudioDraftProvider voice={voice}>{children}</StudioDraftProvider>;
  }
  return Wrapper;
}

describe("useStudioDraft", () => {
  it("returns null when no provider is mounted (library fallback)", () => {
    const { result } = renderHook(() => useStudioDraft());
    expect(result.current).toBeNull();
  });

  it("captures baseSha on first edit and keeps it on later edits", () => {
    const { result } = renderHook(() => useStudioDraft(), { wrapper: wrapperFor("bowtie-editor") });

    act(() => result.current!.setPromptDraft("writer", "v1", "sha-1"));
    act(() => result.current!.setPromptDraft("writer", "v2", "sha-LATER"));

    expect(result.current!.state.prompts.get("writer")).toEqual({ body: "v2", baseSha: "sha-1" });
    expect(result.current!.unsavedCount).toBe(1);
  });

  it("coexists prompt and config drafts in the derived sets", () => {
    const { result } = renderHook(() => useStudioDraft(), { wrapper: wrapperFor("bowtie-editor") });

    act(() => result.current!.setPromptDraft("writer", "v1", "sha-1"));
    act(() => result.current!.setConfigDraft("locale", { output_language: "English" }));

    expect(result.current!.dirtyPromptIds).toEqual(["writer"]);
    expect(result.current!.dirtyConfigKinds).toEqual(["locale"]);
    expect(result.current!.unsavedCount).toBe(2);
  });

  it("resets drafts when remounted per voice (key={slug} at the mount site)", () => {
    // Per-voice reset is now a remount: the mount site passes `key={slug}`, so a
    // voice switch unmounts/remounts the provider and useReducer re-initialises.
    // A bare `voice` prop change on the SAME instance no longer resets (that
    // render-phase dispatch was removed) — `key` forces a fresh instance.
    let captured: ReturnType<typeof useStudioDraft> = null;
    function Capture() {
      captured = useStudioDraft();
      return null;
    }
    const { rerender } = render(
      <StudioDraftProvider key="voice-a" voice="voice-a">
        <Capture />
      </StudioDraftProvider>,
    );

    act(() => captured!.setPromptDraft("writer", "v1", "sha-1"));
    expect(captured!.unsavedCount).toBe(1);

    rerender(
      <StudioDraftProvider key="voice-b" voice="voice-b">
        <Capture />
      </StudioDraftProvider>,
    );
    expect(captured!.unsavedCount).toBe(0);
  });

  it("clearAll discards every draft", () => {
    const { result } = renderHook(() => useStudioDraft(), { wrapper: wrapperFor("bowtie-editor") });

    act(() => result.current!.setPromptDraft("writer", "v1", "sha-1"));
    act(() => result.current!.setConfigDraft("glossary", []));
    act(() => result.current!.clearAll());

    expect(result.current!.unsavedCount).toBe(0);
  });
});
