import { describe, expect, it } from "vitest";

import { buildRecords, distinctVoices, selectTopItems } from "@/lib/runs-grid/select";
import type { BatchStatus, RunSummary, TopicBatch } from "@/lib/types";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "r1",
    status: "hitl_2",
    topic: "Topic",
    article_url: "https://bowtie.com.hk/x",
    mode: "auto",
    created_at: "2026-06-01T00:00:00Z",
    chosen_route: null,
    iteration_count: 0,
    ...overrides,
  };
}

function batch(overrides: Partial<TopicBatch> = {}): TopicBatch {
  return {
    batch_id: "b1",
    status: "ready_for_review" as BatchStatus,
    created_by: "x",
    created_at: "2026-06-02T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
    research_theme: "Theme",
    target_audience: "HK",
    topic_count: 5,
    keywords_per_topic: 5,
    must_cover: [],
    must_avoid: [],
    priority_focus: null,
    notes: null,
    persona_default: null,
    acf_adv_id_default: null,
    acf_widget_id_default: null,
    cost_cents: 0,
    last_error: null,
    ...overrides,
  };
}

describe("selectTopItems", () => {
  const runs = [
    run({ run_id: "rw", start_mode: "refresh" }),
    run({ run_id: "cr", start_mode: "create" }),
    run({ run_id: "promoted", start_mode: "create", topic_candidate_id: "cand1" }),
  ];
  const batches = [batch()];

  it("rewrite tab → refresh runs only", () => {
    expect(selectTopItems("rewrite", runs, batches).runs.map((r) => r.run_id)).toEqual(["rw"]);
    expect(selectTopItems("rewrite", runs, batches).batches).toHaveLength(0);
  });

  it("create tab → all create runs incl. promoted", () => {
    expect(selectTopItems("create", runs, batches).runs.map((r) => r.run_id)).toEqual(["cr", "promoted"]);
  });

  it("topic_gen tab → batches only", () => {
    const sel = selectTopItems("topic_gen", runs, batches);
    expect(sel.runs).toHaveLength(0);
    expect(sel.batches).toHaveLength(1);
  });

  it("all tab → standalone runs (not promoted) + batches", () => {
    const sel = selectTopItems("all", runs, batches);
    expect(sel.runs.map((r) => r.run_id)).toEqual(["rw", "cr"]);
    expect(sel.batches).toHaveLength(1);
  });
});

describe("buildRecords", () => {
  it("tags each record with its group and carries the underlying object", () => {
    const recs = buildRecords("all", [run({ run_id: "rw", start_mode: "refresh" })], [batch()], "", "");
    const runRec = recs.find((r) => r.kind === "run");
    expect(runRec?.group).toBe("review"); // hitl_2
    const batchRec = recs.find((r) => r.kind === "batch");
    expect(batchRec?.group).toBe("review"); // ready_for_review
  });

  it("filters by search across topic / url / id", () => {
    const runs = [run({ run_id: "match", topic: "手足口病" }), run({ run_id: "other", topic: "Diabetes" })];
    expect(buildRecords("rewrite", runs, [], "手足口", "").map((r) => r.id)).toEqual(["match"]);
    expect(buildRecords("rewrite", runs, [], "other", "").map((r) => r.id)).toEqual(["other"]);
  });

  it("filters runs by voice", () => {
    const runs = [run({ run_id: "a", persona: "Dr. Wong" }), run({ run_id: "b", persona: "Amy" })];
    expect(buildRecords("rewrite", runs, [], "", "Dr. Wong").map((r) => r.id)).toEqual(["a"]);
  });
});

describe("distinctVoices", () => {
  it("collects + sorts unique personas from runs and batch defaults", () => {
    const voices = distinctVoices(
      [run({ persona: "Amy" }), run({ persona: "Dr. Wong" }), run({ persona: "Amy" })],
      [batch({ persona_default: "保險編輯" })],
    );
    expect(voices).toEqual(["Amy", "Dr. Wong", "保險編輯"].sort((a, b) => a.localeCompare(b)));
  });
});
