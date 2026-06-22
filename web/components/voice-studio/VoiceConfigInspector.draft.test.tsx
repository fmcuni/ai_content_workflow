import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Persona } from "@/lib/types";

const mockPersonaGet = vi.fn<(slug: string) => Promise<Persona>>();

vi.mock("@/lib/api", () => ({
  personasApi: { get: (slug: string) => mockPersonaGet(slug), update: vi.fn() },
  publishTargetsApi: { list: () => Promise.resolve([]), readiness: vi.fn() },
}));

vi.mock("@/lib/use-role", () => ({ useRole: () => ({ can: () => true, role: "admin" }) }));

import { VoiceConfigInspector } from "@/components/voice-studio/VoiceConfigInspector";
import { isLocaleDraft } from "@/lib/voice-studio/draft-store";
import { StudioDraftProvider, useStudioDraft } from "@/lib/voice-studio/draft-store-provider";

const VOICE = "bowtie-editor";

function persona(): Persona {
  return {
    persona_id: "p1",
    slug: VOICE,
    name: "Editor",
    voice_rules: [],
    banned_terms: [],
    required_phrasings: [],
    disclaimer_templates: {},
    tone_examples: {},
    glossary: [],
    locale: {
      output_language: "繁體中文",
      brand_name: "Bowtie",
      market: "香港",
      sources_heading: null,
      faq_heading: "常見問題",
    },
    publish_target_id: null,
    is_archived: false,
    created_at: "",
    updated_at: "",
    created_by: null,
    updated_by: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPersonaGet.mockResolvedValue(persona());
});

describe("VoiceConfigInspector — locale draft mirroring", () => {
  it("writes a locale edit into the store and clears it when reverted to the server value", async () => {
    const user = userEvent.setup();
    let store: ReturnType<typeof useStudioDraft> = null;
    function Capture() {
      store = useStudioDraft();
      return null;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={qc}>
          <StudioDraftProvider voice={VOICE}>{children}</StudioDraftProvider>
        </QueryClientProvider>
      );
    }
    render(
      <Wrapper>
        <Capture />
        <VoiceConfigInspector voice={VOICE} initialTab="locale" />
      </Wrapper>,
    );

    const brand = await screen.findByDisplayValue("Bowtie");
    await user.type(brand, " HK");

    await waitFor(() => {
      const draft = store!.state.config.locale;
      expect(isLocaleDraft(draft)).toBe(true);
      if (isLocaleDraft(draft)) expect(draft.locale.brand_name).toBe("Bowtie HK");
    });
    expect(store!.dirtyConfigKinds).toEqual(["locale"]);

    // Revert the field back to the server value → the store draft is dropped.
    await user.clear(brand);
    await user.type(brand, "Bowtie");
    await waitFor(() => expect(store!.unsavedCount).toBe(0));
  });

  it("reflects an existing store locale draft on mount", async () => {
    let store: ReturnType<typeof useStudioDraft> = null;
    function Capture() {
      store = useStudioDraft();
      return null;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={qc}>
          <StudioDraftProvider voice={VOICE}>{children}</StudioDraftProvider>
        </QueryClientProvider>
      );
    }
    const { rerender } = render(
      <Wrapper>
        <Capture />
      </Wrapper>,
    );
    await waitFor(() => expect(store).not.toBeNull());
    act(() =>
      store!.setConfigDraft("locale", {
        kind: "locale",
        locale: { ...persona().locale, brand_name: "Prior Edit" },
      }),
    );

    rerender(
      <Wrapper>
        <Capture />
        <VoiceConfigInspector voice={VOICE} initialTab="locale" />
      </Wrapper>,
    );

    expect(await screen.findByDisplayValue("Prior Edit")).toBeInTheDocument();
  });
});
