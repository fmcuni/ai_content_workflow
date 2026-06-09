import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RunSummary } from "@/lib/types";

// The module under test does NOT exist yet — this import drives the RED state.
import { RunEditorShell } from "@/components/run-editor/RunEditorShell";

const RUN_ID = "abcdef12-3456-7890-abcd-ef1234567890";

// RunTaskDetails (rendered inside the shell) resolves the run's topic batch via
// react-query, so every render needs a client in scope. The batch query is
// disabled for runs without a topic_candidate_id, so it never hits the network.
function renderShell(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: RUN_ID,
    status: "hitl_2",
    topic: "Health insurance basics",
    article_url: "https://example.com/post",
    mode: "full_rewrite",
    created_at: "2026-06-01T00:00:00Z",
    chosen_route: null,
    iteration_count: 0,
    keywords: ["alpha", "beta"],
    persona: "Editor",
    ...overrides,
  };
}

describe("RunEditorShell", () => {
  it("renders the kicker, hed, dek, children, and action bar", () => {
    renderShell(
      <RunEditorShell
        runId={RUN_ID}
        run={undefined}
        kicker={<span>My kicker</span>}
        hed="My headline"
        dek="My dek"
        actionBar={<button type="button">Save</button>}
      >
        <section>main column</section>
        <aside>rail</aside>
      </RunEditorShell>,
    );

    expect(screen.getByText("My kicker")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My headline" })).toBeInTheDocument();
    expect(screen.getByText("My dek")).toBeInTheDocument();
    expect(screen.getByText("main column")).toBeInTheDocument();
    expect(screen.getByText("rail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("links the back-link row to the run detail page with a short id", () => {
    renderShell(
      <RunEditorShell runId={RUN_ID} run={undefined} kicker="k" hed="h" dek="d" actionBar={null}>
        <div />
      </RunEditorShell>,
    );

    const link = screen.getByRole("link", { name: /Run · abcdef12/ });
    expect(link).toHaveAttribute("href", `/runs/${RUN_ID}`);
  });

  it("renders the RunTaskDetails brief only when a run is provided", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <RunEditorShell runId={RUN_ID} run={undefined} kicker="k" hed="h" dek="d" actionBar={null}>
          <div />
        </RunEditorShell>
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/Task brief/)).not.toBeInTheDocument();

    rerender(
      <QueryClientProvider client={client}>
        <RunEditorShell runId={RUN_ID} run={makeRun()} kicker="k" hed="h" dek="d" actionBar={null}>
          <div />
        </RunEditorShell>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Task brief/)).toBeInTheDocument();
  });

  it("renders headerActions on the right of the back-link row when provided", () => {
    renderShell(
      <RunEditorShell
        runId={RUN_ID}
        run={undefined}
        kicker="k"
        hed="h"
        dek="d"
        headerActions={<span>save controls</span>}
        actionBar={null}
      >
        <div />
      </RunEditorShell>,
    );
    expect(screen.getByText("save controls")).toBeInTheDocument();
  });

  it("renders the presence slot in the back-link row when provided", () => {
    renderShell(
      <RunEditorShell
        runId={RUN_ID}
        run={undefined}
        kicker="k"
        hed="h"
        dek="d"
        presence={<span>presence avatars</span>}
        headerActions={<span>save controls</span>}
        actionBar={null}
      >
        <div />
      </RunEditorShell>,
    );
    expect(screen.getByText("presence avatars")).toBeInTheDocument();
    expect(screen.getByText("save controls")).toBeInTheDocument();
  });
});
