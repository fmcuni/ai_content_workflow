import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Hitl2Request } from "@/lib/types";

// Keep the option pickers off the network and deterministic.
vi.mock("@/lib/use-wp-options", () => ({
  useWpUsers: () => ({ data: [], isLoading: false }),
  useWpCategories: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/lib/use-ghost-options", () => ({
  useGhostAuthors: () => ({ data: [{ id: "a1", name: "Bow", slug: "bow" }], isLoading: false }),
  useGhostTags: () => ({ data: [{ name: "Body Check", slug: "bc" }], isLoading: false }),
}));
vi.mock("@/lib/api", () => ({ uploadMedia: vi.fn() }));

import { CmsMetaForm } from "@/components/cms/CmsMetaForm";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const FORM: Hitl2Request = { decision: "approve", wp_publish_status: "draft" };

describe("CmsMetaForm", () => {
  it("shows the Category field for a WordPress run", () => {
    wrap(<CmsMetaForm form={FORM} onChange={() => {}} kind="wordpress" runId="r1" />);
    expect(screen.queryByText("Category")).toBeTruthy();
    expect(screen.queryByText("Featured image")).toBeTruthy();
  });

  it("hides Category and adapts to Ghost for a Ghost run", () => {
    wrap(<CmsMetaForm form={FORM} onChange={() => {}} kind="ghost" runId="r1" />);
    // Ghost has no categories — the field must not render.
    expect(screen.queryByText("Category")).toBeNull();
    expect(screen.queryByText("Tags")).toBeTruthy();
    expect(screen.queryByText("Feature image")).toBeTruthy();
    // Status is now the shared base-ui Select for both kinds.
    expect(screen.queryByText("Publish status")).toBeTruthy();
  });

  it("renders the Ghost author as a searchable combobox", () => {
    wrap(<CmsMetaForm form={FORM} onChange={() => {}} kind="ghost" runId="r1" />);
    // The Ghost author picker is the SearchableSelect combobox (parity with WP),
    // not a native dropdown — identified by its type-to-search placeholder.
    expect(screen.getByPlaceholderText("Search author by name…")).toBeTruthy();
  });
});
