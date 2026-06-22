import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PromptTemplate,
  PromptTemplateConsumers,
  PromptTemplateSchema,
  PromptVersionsResponse,
} from "@/lib/types";

const mockTemplate = vi.fn<(id: string, voice: string) => Promise<PromptTemplate>>();
const mockSchema = vi.fn<(id: string, voice: string) => Promise<PromptTemplateSchema>>();
const mockConsumers = vi.fn<(id: string, voice: string) => Promise<PromptTemplateConsumers>>();
const mockHistory = vi.fn<(id: string, voice: string) => Promise<PromptVersionsResponse>>();
const mockPreview =
  vi.fn<(id: string, voice: string, body: unknown) => Promise<{ resolved: string }>>();

vi.mock("@/lib/api", () => ({
  promptsApi: {
    template: (id: string, voice: string) => mockTemplate(id, voice),
    templateSchema: (id: string, voice: string) => mockSchema(id, voice),
    templateConsumers: (id: string, voice: string) => mockConsumers(id, voice),
    templateHistory: (id: string, voice: string) => mockHistory(id, voice),
    previewTemplate: (id: string, voice: string, body: unknown) => mockPreview(id, voice, body),
  },
}));

// RoleButton renders a plain button when the role check is unknown in tests;
// stub useRole so the Save button is enabled-by-capability path is irrelevant
// here (we test buffer + preview, not the save).
vi.mock("@/lib/use-role", () => ({
  useRole: () => ({ can: () => true, role: "admin" }),
}));

import { PromptEditor } from "@/components/prompts/PromptEditor";
import { StudioDraftProvider, useStudioDraft } from "@/lib/voice-studio/draft-store-provider";

const VOICE = "bowtie-editor";

function template(id: string, body: string): PromptTemplate {
  return { template_id: id, template: body, sha256: `sha-${id}`, category: "agent", voice: VOICE };
}

function renderEditor(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <StudioDraftProvider voice={VOICE}>{children}</StudioDraftProvider>
      </QueryClientProvider>
    );
  }
  return render(<Wrapper>{node}</Wrapper>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTemplate.mockImplementation((id) => Promise.resolve(template(id, `SERVER ${id}`)));
  mockSchema.mockResolvedValue({
    template_id: "writer",
    required_placeholders: [],
    found_placeholders: [],
    found_includes: [],
    unknown_includes: [],
  } as PromptTemplateSchema);
  mockConsumers.mockResolvedValue({ template_id: "writer", consumers: ["writer"] });
  mockHistory.mockResolvedValue({ template_id: "writer", versions: [] } as PromptVersionsResponse);
  mockPreview.mockResolvedValue({ resolved: "PREVIEW" });
});

describe("PromptEditor — Studio draft store", () => {
  it("preserves an in-progress draft across a node switch and back", async () => {
    const user = userEvent.setup();
    function Switcher() {
      const [id, setId] = useState<string>("a");
      return (
        <>
          <button type="button" onClick={() => setId(id === "a" ? "b" : "a")}>
            toggle
          </button>
          <PromptEditor templateId={id} voice={VOICE} compact />
        </>
      );
    }
    renderEditor(<Switcher />);

    const area = await screen.findByDisplayValue("SERVER a");
    await user.clear(area);
    await user.type(area, "EDITED a");
    expect(await screen.findByDisplayValue("EDITED a")).toBeInTheDocument();

    // Switch to b, then back to a — the draft for a must survive (store outlives
    // the editor remount).
    await user.click(screen.getByText("toggle"));
    await screen.findByDisplayValue("SERVER b");
    await user.click(screen.getByText("toggle"));
    expect(await screen.findByDisplayValue("EDITED a")).toBeInTheDocument();
  });

  it("sends sibling partial drafts and config drafts in the preview body", async () => {
    let store: ReturnType<typeof useStudioDraft> = null;
    function Capture() {
      store = useStudioDraft();
      return null;
    }
    renderEditor(
      <>
        <Capture />
        <PromptEditor templateId="writer" voice={VOICE} compact />
      </>,
    );
    await screen.findByDisplayValue("SERVER writer");

    // Seed an OTHER partial draft + config drafts in the store.
    act(() => {
      store!.setPromptDraft("persona_block", "DRAFT PERSONA", "sha-pb");
      store!.setConfigDraft("locale", { kind: "locale", locale: { output_language: "English" } });
      store!.setConfigDraft("glossary", { kind: "glossary", glossary: [] });
      store!.setConfigDraft("source_policy", {
        kind: "source_policy",
        policy: { deny: { domains: [], tlds: [] } },
        baseSha: "pol",
      });
    });

    await waitFor(
      () => {
        const lastCall = mockPreview.mock.calls.at(-1);
        expect(lastCall).toBeDefined();
        const body = lastCall![2] as Record<string, unknown>;
        // Focused id is sent as `template`; siblings go in partial_overrides.
        expect(body.partial_overrides).toEqual({ persona_block: "DRAFT PERSONA" });
        expect(body.locale).toEqual({ output_language: "English" });
        expect(body.glossary).toEqual([]);
        expect(body.source_policy).toEqual({ deny: { domains: [], tlds: [] } });
      },
      { timeout: 2000 },
    );
  });
});
