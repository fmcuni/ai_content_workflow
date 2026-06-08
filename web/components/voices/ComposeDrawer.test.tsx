import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { Persona } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  personasApi: { create: vi.fn(), update: vi.fn(), archive: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ComposeDrawer } from "@/components/voices/ComposeDrawer";

function makePersona(): Persona {
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
    publish_target_id: null,
    is_archived: false,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    created_by: null,
    updated_by: null,
  };
}

function renderDrawer(isLastVoice: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  render(
    <ComposeDrawer
      mode={{ kind: "edit", persona: makePersona() }}
      isLastVoice={isLastVoice}
      onClose={() => {}}
      onSaved={() => {}}
    />,
    { wrapper },
  );
}

describe("ComposeDrawer — last-voice archive guard", () => {
  it("disables the archive control with a tooltip when it is the last voice", () => {
    renderDrawer(true);
    const archive = screen.getByRole("button", { name: "Archive this voice" });
    expect(archive).toBeDisabled();
    expect(archive).toHaveAttribute("title", expect.stringMatching(/last remaining voice/i));
  });

  it("enables the archive control when other voices remain", () => {
    renderDrawer(false);
    const archive = screen.getByRole("button", { name: "Archive this voice" });
    expect(archive).toBeEnabled();
    expect(archive).not.toHaveAttribute("title");
  });
});
