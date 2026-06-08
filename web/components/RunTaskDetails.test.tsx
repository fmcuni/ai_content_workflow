import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { RunSummary, TopicBatch } from "@/lib/types";

// Mock the batch resolver so the brief renders without a react-query client and
// we can drive the "Topic batch" field deterministically.
const mockBatch = vi.fn<() => TopicBatch | null | undefined>();
vi.mock("@/lib/run-editor/useTopicBatchForRun", () => ({
  useTopicBatchForRun: () => mockBatch(),
}));

import { RunTaskDetails } from "@/components/RunTaskDetails";

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "r1",
    status: "persisted",
    topic: "Health insurance basics",
    article_url: "https://example.com/post",
    mode: "full_rewrite",
    created_at: "2026-06-01T00:00:00Z",
    chosen_route: null,
    iteration_count: 0,
    keywords: ["alpha"],
    persona: "Editor",
    ...overrides,
  };
}

describe("RunTaskDetails", () => {
  beforeEach(() => mockBatch.mockReturnValue(undefined));

  it("shows the source URL for rewrite runs", () => {
    render(<RunTaskDetails run={makeRun({ start_mode: "refresh" })} />);
    expect(screen.getByText("Source URL")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /example\.com\/post/ });
    expect(link).toHaveAttribute("href", "https://example.com/post");
  });

  it("hides the source URL on create runs", () => {
    render(<RunTaskDetails run={makeRun({ start_mode: "create" })} />);
    expect(screen.queryByText("Source URL")).not.toBeInTheDocument();
  });

  it("renders 'none' for empty advertiser and widget ids", () => {
    render(<RunTaskDetails run={makeRun({ acf_adv_id: null, acf_widget_id: null })} />);
    expect(screen.getByText("Adv ID")).toBeInTheDocument();
    expect(screen.getByText("Widget ID")).toBeInTheDocument();
    // Voice + keywords are populated, so the only "none" values are the two ids.
    expect(screen.getAllByText("none")).toHaveLength(2);
  });

  it("shows the edit note when present and omits it otherwise", () => {
    const { rerender } = render(<RunTaskDetails run={makeRun()} />);
    expect(screen.queryByText("Edit note")).not.toBeInTheDocument();

    rerender(<RunTaskDetails run={makeRun({ edit_note: "Tighten the intro" })} />);
    expect(screen.getByText("Edit note")).toBeInTheDocument();
    expect(screen.getByText("Tighten the intro")).toBeInTheDocument();
  });

  it("links to the resolved topic batch when the run was promoted", () => {
    mockBatch.mockReturnValue({
      batch_id: "batch123-aaaa-bbbb",
      research_theme: "Summer health",
    } as TopicBatch);
    render(<RunTaskDetails run={makeRun({ topic_candidate_id: "cand-1" })} />);
    expect(screen.getByText("Topic batch")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Summer health/ });
    expect(link).toHaveAttribute("href", "/topic-batches/batch123-aaaa-bbbb");
  });

  it("omits the topic batch field when the run has no batch", () => {
    mockBatch.mockReturnValue(null);
    render(<RunTaskDetails run={makeRun()} />);
    expect(screen.queryByText("Topic batch")).not.toBeInTheDocument();
  });
});
