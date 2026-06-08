import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { VoiceSelector } from "@/components/prompts/VoiceSelector";
import type { Persona } from "@/lib/types";

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    persona_id: `id-${overrides.slug ?? "x"}`,
    slug: "bowtie-editor",
    name: "Bowtie Editor",
    voice_rules: [],
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
    ...overrides,
  };
}

const PERSONAS: Persona[] = [
  makePersona({ slug: "bowtie-editor", name: "Bowtie Editor" }),
  makePersona({ slug: "playful", name: "Playful" }),
];

describe("VoiceSelector", () => {
  it("renders an option per voice with the selected value active", () => {
    render(<VoiceSelector personas={PERSONAS} value="bowtie-editor" onChange={() => {}} />);
    const select = screen.getByRole("combobox", { name: "Voice" });
    expect(select).toHaveValue("bowtie-editor");
    expect(screen.getByRole("option", { name: "Bowtie Editor" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Playful" })).toBeInTheDocument();
  });

  it("fires onChange with the newly selected slug", async () => {
    const onChange = vi.fn();
    render(<VoiceSelector personas={PERSONAS} value="bowtie-editor" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Voice" }), "playful");
    expect(onChange).toHaveBeenCalledWith("playful");
  });

  it("marks archived voices in the option label", () => {
    const withArchived = [...PERSONAS, makePersona({ slug: "retired", name: "Retired", is_archived: true })];
    render(<VoiceSelector personas={withArchived} value="bowtie-editor" onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Retired (archived)" })).toBeInTheDocument();
  });
});
