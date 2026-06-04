import { describe, expect, it } from "vitest";

import { mapPromotedRuns, promotedRunIds } from "@/lib/runs-grid/use-batch-children";
import type { RunSummary, TopicCandidate } from "@/lib/types";

function candidate(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    candidate_id: "c1",
    batch_id: "b1",
    position: 0,
    status: "candidate",
    topic: "Topic",
    keywords: [],
    original_topic: "Topic",
    original_keywords: [],
    existing: null,
    existing_note: null,
    existing_url: null,
    hot_topic: null,
    hot_topic_note: null,
    existing_search_debug: null,
    persona_slug: null,
    acf_adv_id: null,
    acf_widget_id: null,
    operator_note: null,
    promote_mode: null,
    promoted_run_id: null,
    last_error: null,
    last_edited_by: null,
    last_edited_at: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function run(id: string): RunSummary {
  return {
    run_id: id,
    status: "persisted",
    topic: `Run ${id}`,
    article_url: "",
    mode: "auto",
    created_at: "2026-06-01T00:00:00Z",
    chosen_route: null,
    iteration_count: 0,
  };
}

describe("promotedRunIds", () => {
  it("returns [] for null/undefined/empty candidates", () => {
    expect(promotedRunIds(null)).toEqual([]);
    expect(promotedRunIds(undefined)).toEqual([]);
    expect(promotedRunIds([])).toEqual([]);
  });

  it("keeps only promoted candidates, in position order", () => {
    const cands = [
      candidate({ candidate_id: "c3", position: 2, promoted_run_id: "r3" }),
      candidate({ candidate_id: "c1", position: 0, promoted_run_id: "r1" }),
      candidate({ candidate_id: "c2", position: 1, promoted_run_id: null }),
    ];
    expect(promotedRunIds(cands)).toEqual(["r1", "r3"]);
  });
});

describe("mapPromotedRuns", () => {
  it("resolves promoted ids to run rows in position order", () => {
    const cands = [
      candidate({ candidate_id: "c2", position: 1, promoted_run_id: "r2" }),
      candidate({ candidate_id: "c1", position: 0, promoted_run_id: "r1" }),
    ];
    const runsById = new Map([
      ["r1", run("r1")],
      ["r2", run("r2")],
    ]);
    expect(mapPromotedRuns(cands, runsById).map((r) => r.run_id)).toEqual(["r1", "r2"]);
  });

  it("skips a promoted run that is not in the loaded list (no phantom rows)", () => {
    const cands = [
      candidate({ position: 0, promoted_run_id: "present" }),
      candidate({ position: 1, promoted_run_id: "missing" }),
    ];
    const runsById = new Map([["present", run("present")]]);
    expect(mapPromotedRuns(cands, runsById).map((r) => r.run_id)).toEqual(["present"]);
  });
});
