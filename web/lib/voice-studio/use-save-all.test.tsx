import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PromptSaveResponse, PromptTemplateSchema } from "@/lib/types";

const mockSaveTemplate =
  vi.fn<(id: string, voice: string, body: unknown) => Promise<PromptSaveResponse>>();
const mockTemplateSchema = vi.fn<(id: string, voice: string) => Promise<PromptTemplateSchema>>();
const mockPersonaUpdate = vi.fn<(slug: string, patch: unknown) => Promise<unknown>>();
const mockPolicySave = vi.fn<(voice: string, body: unknown) => Promise<unknown>>();

vi.mock("@/lib/api", () => ({
  promptsApi: {
    saveTemplate: (id: string, voice: string, body: unknown) => mockSaveTemplate(id, voice, body),
    templateSchema: (id: string, voice: string) => mockTemplateSchema(id, voice),
  },
  personasApi: { update: (slug: string, patch: unknown) => mockPersonaUpdate(slug, patch) },
  sourcePolicyApi: { save: (voice: string, body: unknown) => mockPolicySave(voice, body) },
}));

import { StudioDraftProvider, useStudioDraft } from "@/lib/voice-studio/draft-store-provider";
import { useSaveAll } from "@/lib/voice-studio/use-save-all";

const VOICE = "bowtie-editor";

function schema(required: string[]): PromptTemplateSchema {
  return {
    template_id: "writer",
    required_placeholders: required,
    found_placeholders: [],
    found_includes: [],
    unknown_includes: [],
  } as PromptTemplateSchema;
}

function saveResponse(sha: string): PromptSaveResponse {
  return { template_id: "writer", sha256: sha } as PromptSaveResponse;
}

function useCombined() {
  return { studio: useStudioDraft()!, save: useSaveAll(VOICE) };
}

function renderCombined() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <StudioDraftProvider voice={VOICE}>{children}</StudioDraftProvider>
      </QueryClientProvider>
    );
  }
  return renderHook(useCombined, { wrapper: Wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTemplateSchema.mockResolvedValue(schema([]));
  mockSaveTemplate.mockResolvedValue(saveResponse("sha-new"));
  mockPersonaUpdate.mockResolvedValue({});
  mockPolicySave.mockResolvedValue({});
});

describe("useSaveAll", () => {
  it("aborts before any network call when a draft is missing a required placeholder", async () => {
    mockTemplateSchema.mockResolvedValue(schema(["article"]));
    const { result } = renderCombined();
    act(() => result.current.studio.setPromptDraft("writer", "body without token", "sha-1"));

    let report: Awaited<ReturnType<typeof result.current.save.saveAll>> | undefined;
    await act(async () => {
      report = await result.current.save.saveAll();
    });

    expect(mockSaveTemplate).not.toHaveBeenCalled();
    expect(report!.validationErrors).toHaveLength(1);
    expect(report!.validationErrors[0]).toMatchObject({
      templateId: "writer",
      missingPlaceholders: ["article"],
    });
    // Draft stays dirty after a validation abort.
    expect(result.current.studio.unsavedCount).toBe(1);
  });

  it("aborts when a draft body exceeds 64 KiB", async () => {
    const { result } = renderCombined();
    const tooBig = "x".repeat(64 * 1024 + 1);
    act(() => result.current.studio.setPromptDraft("writer", tooBig, "sha-1"));

    let report: Awaited<ReturnType<typeof result.current.save.saveAll>> | undefined;
    await act(async () => {
      report = await result.current.save.saveAll();
    });

    expect(mockSaveTemplate).not.toHaveBeenCalled();
    expect(report!.validationErrors[0]).toMatchObject({ templateId: "writer", tooLarge: true });
  });

  it("dispatches prompt saves with the captured baseSha and the batch note, then commits", async () => {
    const { result } = renderCombined();
    act(() => result.current.studio.setPromptDraft("writer", "ok {x}", "sha-base"));

    await act(async () => {
      await result.current.save.saveAll("batch reason");
    });

    expect(mockSaveTemplate).toHaveBeenCalledWith("writer", VOICE, {
      template: "ok {x}",
      expected_sha256: "sha-base",
      note: "batch reason",
    });
    // Committed → no longer dirty.
    expect(result.current.studio.unsavedCount).toBe(0);
  });

  it("reports partial failure honestly and keeps the conflicted draft dirty", async () => {
    mockSaveTemplate
      .mockResolvedValueOnce(saveResponse("sha-a"))
      .mockRejectedValueOnce(new Error("409 conflict"));
    const { result } = renderCombined();
    act(() => result.current.studio.setPromptDraft("a", "body {x}", "sha-a"));
    act(() => result.current.studio.setPromptDraft("b", "body {x}", "sha-b"));

    let report: Awaited<ReturnType<typeof result.current.save.saveAll>> | undefined;
    await act(async () => {
      report = await result.current.save.saveAll();
    });

    expect(report!.total).toBe(2);
    expect(report!.ok).toBe(1);
    const failed = report!.items.find((i) => !i.ok);
    expect(failed).toMatchObject({ target: "prompt", ok: false, conflict: true });
    // One committed, one still dirty.
    expect(result.current.studio.unsavedCount).toBe(1);
    expect(result.current.studio.dirtyPromptIds).toEqual(["b"]);
  });

  it("dispatches config drafts to the right endpoint and labels them", async () => {
    const { result } = renderCombined();
    act(() =>
      result.current.studio.setConfigDraft("locale", {
        kind: "locale",
        locale: { output_language: "English" },
      }),
    );
    act(() =>
      result.current.studio.setConfigDraft("source_policy", {
        kind: "source_policy",
        policy: { deny: { domains: [], tlds: [] } },
        baseSha: "pol-sha",
      }),
    );

    let report: Awaited<ReturnType<typeof result.current.save.saveAll>> | undefined;
    await act(async () => {
      report = await result.current.save.saveAll("ignored-by-config");
    });

    expect(mockPersonaUpdate).toHaveBeenCalledWith(VOICE, { locale: { output_language: "English" } });
    expect(mockPolicySave).toHaveBeenCalledWith(VOICE, {
      policy: { deny: { domains: [], tlds: [] } },
      expected_sha256: "pol-sha",
    });
    expect(report!.items.every((i) => i.target === "config")).toBe(true);
    expect(result.current.studio.unsavedCount).toBe(0);
  });

  it("is a no-op with an empty report when no provider is mounted", async () => {
    const qc = new QueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useSaveAll(VOICE), { wrapper: Wrapper });
    let report: Awaited<ReturnType<typeof result.current.saveAll>> | undefined;
    await act(async () => {
      report = await result.current.saveAll();
    });
    expect(report).toEqual({ validationErrors: [], items: [], ok: 0, total: 0 });
  });
});
