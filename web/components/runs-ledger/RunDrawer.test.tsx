import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { Persona, PublishTarget, RunSummary } from "@/lib/types";

// Mock the whole API layer so the drawer's queries (run detail, WP options,
// gap/outline/existing-post, snapshots + latest render driven by useCmsAutosave)
// all resolve deterministically without the network.
const mockApi = vi.hoisted(() => ({
  getRun: vi.fn(),
  listWpUsers: vi.fn(),
  listWpCategories: vi.fn(),
  getGapAnalysis: vi.fn(),
  getOutline: vi.fn(),
  getExistingPost: vi.fn(),
  listGhostAuthors: vi.fn(),
  listGhostTags: vi.fn(),
  listHitl2Snapshots: vi.fn(),
  getLatestRender: vi.fn(),
  saveHitl2Snapshot: vi.fn(),
  patchRun: vi.fn(),
  dryPublish: vi.fn(),
  resumeHitl2: vi.fn(),
  resumeHitl1: vi.fn(),
  restartRun: vi.fn(),
  republish: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: mockApi }));

// sonner toast is irrelevant to the mode-switch assertions; stub it.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { RunDrawer, type DrawerPerms } from "./RunDrawer";

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "drawer-run-1",
    status: "hitl_2",
    topic: "Health insurance basics",
    article_url: "https://gobowtie.com/blog/health",
    mode: "full_rewrite",
    created_at: "2026-06-12T09:30:00Z",
    chosen_route: null,
    iteration_count: 0,
    seo_title: "Health insurance basics",
    meta_description: "A primer.",
    ...overrides,
  };
}

const ALL_PERMS: DrawerPerms = {
  canEditMeta: true,
  canPatch: true,
  canPublish: true,
  canApproveOutline: true,
  canRestart: true,
  canRepublish: true,
};

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function renderDrawer(
  run: RunSummary,
  perms: DrawerPerms = ALL_PERMS,
  themeTitle: string | null = null,
  maps?: { personaBySlug: Map<string, Persona>; targetById: Map<string, PublishTarget> },
) {
  const Wrapper = wrapper();
  return render(
    <Wrapper>
      <RunDrawer
        run={run}
        personaBySlug={maps?.personaBySlug ?? new Map()}
        targetById={maps?.targetById ?? new Map()}
        editorEmail="op@bowtie.com.hk"
        perms={perms}
        themeTitle={themeTitle}
        onClose={vi.fn()}
        onStep={vi.fn()}
      />
    </Wrapper>,
  );
}

// Persona + target maps that resolve a run to a Ghost CMS destination (tag "GT").
function ghostMaps(): { personaBySlug: Map<string, Persona>; targetById: Map<string, PublishTarget> } {
  const target = { publish_target_id: "t-ghost", name: "Healthy Check", kind: "ghost" } as PublishTarget;
  const persona = { slug: "hc", name: "Healthy Check", publish_target_id: "t-ghost" } as Persona;
  return {
    personaBySlug: new Map([[persona.slug, persona]]),
    targetById: new Map([[target.publish_target_id, target]]),
  };
}

beforeEach(() => {
  Object.values(mockApi).forEach((fn) => fn.mockReset());
  mockApi.getRun.mockImplementation((id: string) => Promise.resolve(makeRun({ run_id: id })));
  mockApi.listWpUsers.mockResolvedValue([]);
  mockApi.listWpCategories.mockResolvedValue([]);
  mockApi.getGapAnalysis.mockResolvedValue(null);
  mockApi.getOutline.mockResolvedValue({ payload: { h1: "H", sections: [] } });
  mockApi.getExistingPost.mockResolvedValue(null);
  mockApi.listGhostAuthors.mockResolvedValue([{ id: "ga1", name: "Ghostwriter", slug: "gw" }]);
  mockApi.listGhostTags.mockResolvedValue([{ name: "Wellness", slug: "wellness" }]);
  mockApi.listHitl2Snapshots.mockResolvedValue([]);
  mockApi.getLatestRender.mockResolvedValue(null);
});

describe("RunDrawer mode switch", () => {
  it("renders the outline mode for hitl_1 runs", async () => {
    renderDrawer(makeRun({ status: "hitl_1" }));

    // Outline-mode column headers.
    expect(await screen.findByText("Gap analysis")).toBeInTheDocument();
    expect(screen.getByText("Outline")).toBeInTheDocument();

    // The HITL_1 gate action is present when permitted.
    expect(screen.getByRole("button", { name: /Approve outline/i })).toBeInTheDocument();

    // The CMS-destination SEO title field is a hitl_2-only surface.
    expect(screen.queryByText("SEO title")).not.toBeInTheDocument();
  });

  it("renders the draft + CMS-destination mode for hitl_2 runs", async () => {
    renderDrawer(makeRun({ status: "hitl_2" }));

    // Default-mode column headers.
    expect(await screen.findByText("Draft preview")).toBeInTheDocument();
    expect(screen.getByText("CMS destination")).toBeInTheDocument();

    // The SEO title field is present in hitl_2 mode.
    expect(screen.getByText("SEO title")).toBeInTheDocument();

    // The HITL_2 publish action is present when permitted.
    expect(screen.getByRole("button", { name: /Approve & publish/i })).toBeInTheDocument();
  });
});

describe("RunDrawer theme back-link", () => {
  it("links a promoted run back to its topic batch with the theme title", async () => {
    const run = makeRun({ topic_batch_id: "batch-xyz-123456" });
    // The drawer re-fetches via getRun; echo the same run so topic_batch_id survives.
    mockApi.getRun.mockResolvedValue(run);

    renderDrawer(run, ALL_PERMS, "Summer skincare");

    const link = await screen.findByRole("link", { name: /Summer skincare/ });
    expect(link).toHaveAttribute("href", "/topic-batches/batch-xyz-123456");
  });

  it("falls back to the batch id when the theme title is unknown", async () => {
    const run = makeRun({ topic_batch_id: "batch-xyz-123456" });
    mockApi.getRun.mockResolvedValue(run);

    renderDrawer(run, ALL_PERMS, null);

    const link = await screen.findByRole("link", { name: /batch-xy/ });
    expect(link).toHaveAttribute("href", "/topic-batches/batch-xyz-123456");
  });

  it("omits the theme link for standalone runs", async () => {
    renderDrawer(makeRun({ topic_batch_id: null }));

    await screen.findByText("Brief");
    expect(screen.queryByText("Theme")).not.toBeInTheDocument();
  });
});

describe("RunDrawer Ghost CMS fields", () => {
  it("renders an author combobox and a tags input for a Ghost run", async () => {
    const run = makeRun({ status: "hitl_2", persona: "hc" });
    mockApi.getRun.mockResolvedValue(run);

    renderDrawer(run, ALL_PERMS, null, ghostMaps());

    // The Ghost author is now a searchable combobox (parity with WordPress),
    // not the old "set in the review screen" hint.
    expect(await screen.findByPlaceholderText("Search author by name…")).toBeInTheDocument();
    // Tags are editable inline via the tag picker input.
    expect(screen.getByPlaceholderText("Type a tag, press Enter…")).toBeInTheDocument();
    // The feature image field is now available inline for Ghost runs.
    expect(screen.getByText("Feature image")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("or paste an image URL")).toBeInTheDocument();
    // The retired hint must be gone.
    expect(screen.queryByText(/set in the review screen/i)).not.toBeInTheDocument();

    // Draft Preview still renders for a Ghost run.
    expect(screen.getByText("Draft preview")).toBeInTheDocument();
  });

  it("renders the WordPress author and category comboboxes for a WP run", async () => {
    const run = makeRun({ status: "hitl_2" });
    mockApi.getRun.mockResolvedValue(run);
    mockApi.listWpUsers.mockResolvedValue([{ id: 1, name: "Editor", slug: "editor" }]);
    mockApi.listWpCategories.mockResolvedValue([{ id: 2, name: "Health", slug: "health" }]);

    renderDrawer(run);

    // Default target (no persona) → WordPress (tag "WP"): author + category fields.
    expect(await screen.findByText("Author")).toBeInTheDocument();
    expect(screen.getByText("Category")).toBeInTheDocument();
    // No Ghost-only tag input on a WordPress run.
    expect(screen.queryByPlaceholderText("Type a tag, press Enter…")).not.toBeInTheDocument();
  });
});
