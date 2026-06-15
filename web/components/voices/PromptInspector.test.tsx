import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { PromptNode, VoiceLocale } from "@/lib/types";

const previewMock = vi.fn();
vi.mock("@/lib/api", () => ({
  promptsApi: {
    template: vi.fn().mockResolvedValue({ template: "Brand: {brand_name}", expected_sha256: "x" }),
    previewTemplate: (...args: unknown[]) => previewMock(...args),
  },
}));
// UserExamplePicker hits the network on mount; not needed for create/topic modes.
vi.mock("./UserExamplePicker", () => ({ UserExamplePicker: () => null }));

import { PromptInspector } from "@/components/voices/PromptInspector";

const node: PromptNode = {
  id: "writer",
  sub_graph: "production",
  order: 1,
  kind: "llm",
  uses_persona: true,
  system_prompt_template_id: "writer",
  description: "writer",
};

const liveLocale: VoiceLocale = {
  output_language: "English",
  brand_name: "Acme",
  market: "Google MY",
  sources_heading: null,
  faq_heading: "FAQ",
  ui_lang: "en",
};

function renderInspector(withLocale: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  render(
    <PromptInspector
      node={node}
      mode="create"
      voice="bowtie-en-my"
      liveLocale={withLocale ? liveLocale : undefined}
    />,
    { wrapper },
  );
}

describe("PromptInspector — live locale preview", () => {
  it("passes the live locale into the preview call (debounced)", async () => {
    previewMock.mockReset().mockResolvedValue({ resolved: "Brand: Acme", route: "create" });
    renderInspector(true);
    await waitFor(
      () => {
        expect(previewMock).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
    const [id, voice, body] = previewMock.mock.calls[0] as [
      string,
      string,
      { locale?: VoiceLocale },
    ];
    expect(id).toBe("writer");
    expect(voice).toBe("bowtie-en-my");
    expect(body.locale).toEqual(liveLocale);
  });

  it("does not call preview when no live locale is supplied", async () => {
    previewMock.mockReset();
    renderInspector(false);
    // Raw template renders; give the debounce a beat to (not) fire.
    await screen.findByText(/Brand: \{brand_name\}/);
    expect(previewMock).not.toHaveBeenCalled();
  });
});
