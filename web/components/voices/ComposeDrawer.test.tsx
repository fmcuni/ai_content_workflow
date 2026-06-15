import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { Persona, PersonaPatch } from "@/lib/types";

const updateMock = vi.fn();
vi.mock("@/lib/api", () => ({
  personasApi: {
    create: vi.fn(),
    update: (...args: unknown[]) => updateMock(...args),
    archive: vi.fn(),
  },
  publishTargetsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ComposeDrawer } from "@/components/voices/ComposeDrawer";

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    persona_id: "id-bowtie-editor",
    slug: "bowtie-editor",
    name: "Bowtie Editor",
    voice_rules: ["keep it warm"],
    banned_terms: [],
    required_phrasings: [],
    disclaimer_templates: {},
    tone_examples: {},
    glossary: [],
    locale: {
      output_language: "香港繁體中文",
      brand_name: "Bowtie",
      market: "Google 香港繁中",
      sources_heading: null,
      faq_heading: "常見問題",
    },
    publish_target_id: null,
    is_archived: false,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

function renderDrawer(opts: { isLastVoice?: boolean; persona?: Persona } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  render(
    <ComposeDrawer
      mode={{ kind: "edit", persona: opts.persona ?? makePersona() }}
      isLastVoice={opts.isLastVoice ?? false}
      onClose={() => {}}
      onSaved={() => {}}
    />,
    { wrapper },
  );
}

describe("ComposeDrawer — last-voice archive guard", () => {
  it("disables the archive control with a tooltip when it is the last voice", () => {
    renderDrawer({ isLastVoice: true });
    const archive = screen.getByRole("button", { name: "Archive this voice" });
    expect(archive).toBeDisabled();
    expect(archive).toHaveAttribute("title", expect.stringMatching(/last remaining voice/i));
  });

  it("enables the archive control when other voices remain", () => {
    renderDrawer({ isLastVoice: false });
    const archive = screen.getByRole("button", { name: "Archive this voice" });
    expect(archive).toBeEnabled();
    expect(archive).not.toHaveAttribute("title");
  });
});

describe("ComposeDrawer — Locale & Brand section", () => {
  it("renders the 6 locale controls initialised from the persona", () => {
    renderDrawer();
    expect(screen.getByLabelText(/Output language/)).toHaveValue("香港繁體中文");
    expect(screen.getByLabelText(/Brand name/)).toHaveValue("Bowtie");
    expect(screen.getByLabelText(/Market/)).toHaveValue("Google 香港繁中");
    // null sources_heading renders as empty input.
    expect(screen.getByLabelText(/Sources heading/)).toHaveValue("");
    expect(screen.getByLabelText(/FAQ heading/)).toHaveValue("常見問題");
  });

  it("includes the whole locale object in the update patch on save", async () => {
    updateMock.mockReset().mockResolvedValue(makePersona());
    renderDrawer();
    fireEvent.change(screen.getByLabelText(/Brand name/), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const [, patch] = updateMock.mock.calls[0] as [string, PersonaPatch];
    expect(patch.locale).toEqual({
      output_language: "香港繁體中文",
      brand_name: "Acme",
      market: "Google 香港繁中",
      sources_heading: null,
      faq_heading: "常見問題",
    });
  });

  it("submits a blank sources_heading as null", async () => {
    updateMock.mockReset().mockResolvedValue(makePersona());
    const persona = makePersona({
      locale: {
        output_language: "English",
        brand_name: "Bowtie",
        market: "Google MY",
        sources_heading: "Sources",
        faq_heading: "FAQ",
      },
    });
    renderDrawer({ persona });
    // Clear the pre-filled sources heading.
    fireEvent.change(screen.getByLabelText(/Sources heading/), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const [, patch] = updateMock.mock.calls[0] as [string, PersonaPatch];
    expect(patch.locale?.sources_heading).toBeNull();
  });
});
