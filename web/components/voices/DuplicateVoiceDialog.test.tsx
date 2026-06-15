import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { Persona } from "@/lib/types";

// Mock the API + toast so the dialog runs without a network call or a Toaster.
vi.mock("@/lib/api", () => ({
  personasApi: { duplicate: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { personasApi } from "@/lib/api";
import { DuplicateVoiceDialog } from "@/components/voices/DuplicateVoiceDialog";

const duplicateMock = vi.mocked(personasApi.duplicate);

function makePersona(slug: string, name: string): Persona {
  return {
    persona_id: `id-${slug}`,
    slug,
    name,
    voice_rules: [],
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
  };
}

const CANDIDATES = [
  makePersona("bowtie-editor", "Bowtie Editor"),
  makePersona("playful", "Playful"),
];

function renderDialog(onDuplicated = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  render(
    <DuplicateVoiceDialog candidates={CANDIDATES} onClose={onClose} onDuplicated={onDuplicated} />,
    { wrapper },
  );
  return { onDuplicated, onClose };
}

beforeEach(() => {
  duplicateMock.mockReset();
});

describe("DuplicateVoiceDialog", () => {
  it("renders a source option per candidate plus slug + name fields", () => {
    renderDialog();
    expect(screen.getByRole("combobox", { name: "Copy from" })).toHaveValue("bowtie-editor");
    expect(screen.getByRole("option", { name: "Playful (playful)" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New slug" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New name" })).toBeInTheDocument();
  });

  it("blocks submit and shows a validation error for a malformed slug", async () => {
    renderDialog();
    await userEvent.type(screen.getByRole("textbox", { name: "New slug" }), "Bad Slug");
    await userEvent.type(screen.getByRole("textbox", { name: "New name" }), "Bad Slug Voice");
    await userEvent.click(screen.getByRole("button", { name: /duplicate voice/i }));

    expect(duplicateMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/lowercase letters/i);
  });

  it("surfaces a 409 duplicate-slug error from the server", async () => {
    duplicateMock.mockRejectedValueOnce(new Error("409: slug 'taken' already exists"));
    const { onDuplicated } = renderDialog();
    await userEvent.type(screen.getByRole("textbox", { name: "New slug" }), "taken");
    await userEvent.type(screen.getByRole("textbox", { name: "New name" }), "Taken Voice");
    await userEvent.click(screen.getByRole("button", { name: /duplicate voice/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
    expect(onDuplicated).not.toHaveBeenCalled();
  });

  it("surfaces a 404 unknown-source error from the server", async () => {
    duplicateMock.mockRejectedValueOnce(new Error("404: persona 'ghost' not found"));
    renderDialog();
    await userEvent.type(screen.getByRole("textbox", { name: "New slug" }), "fresh-voice");
    await userEvent.type(screen.getByRole("textbox", { name: "New name" }), "Fresh Voice");
    await userEvent.click(screen.getByRole("button", { name: /duplicate voice/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not found/i);
  });

  it("calls onDuplicated with the new slug on success", async () => {
    duplicateMock.mockResolvedValueOnce(makePersona("fresh-voice", "Fresh Voice"));
    const { onDuplicated } = renderDialog();
    await userEvent.type(screen.getByRole("textbox", { name: "New slug" }), "fresh-voice");
    await userEvent.type(screen.getByRole("textbox", { name: "New name" }), "Fresh Voice");
    await userEvent.click(screen.getByRole("button", { name: /duplicate voice/i }));

    await vi.waitFor(() => expect(onDuplicated).toHaveBeenCalledWith("fresh-voice"));
    expect(duplicateMock).toHaveBeenCalledWith("bowtie-editor", {
      slug: "fresh-voice",
      name: "Fresh Voice",
    });
  });
});
