import { describe, expect, it } from "vitest";

import type { RunSummary, TopicBatch } from "@/lib/types";

import { buildBoard, summarizeChildren } from "./board";
import type { RunFilterOpts, SortOrder } from "./useLedgerData";

function mkRun(over: Partial<RunSummary> & Pick<RunSummary, "run_id">): RunSummary {
  return {
    status: "published",
    topic: "Topic",
    mode: "rewrite",
    created_at: "2026-06-01T00:00:00Z",
    ...over,
  } as RunSummary;
}

function mkBatch(over: Partial<TopicBatch> & Pick<TopicBatch, "batch_id">): TopicBatch {
  return {
    status: "ready_for_review",
    created_by: "ed@bowtie",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    research_theme: "Theme",
    target_audience: "HK families",
    topic_count: 3,
    keywords_per_topic: 2,
    must_cover: [],
    must_avoid: [],
    priority_focus: null,
    notes: null,
    persona_default: null,
    acf_adv_id_default: null,
    acf_widget_id_default: null,
    cost_cents: 0,
    last_error: null,
    ...over,
  } as TopicBatch;
}

const ALL: RunFilterOpts & { sort: SortOrder } = {
  tab: "all",
  voice: "",
  creator: "",
  search: "",
  sort: "newest",
};

describe("buildBoard", () => {
  it("nests promoted runs under their theme and keeps no-theme runs standalone", () => {
    const batches = [mkBatch({ batch_id: "b1", research_theme: "Dengue" })];
    const runs = [
      mkRun({ run_id: "r1", topic_batch_id: "b1" }),
      mkRun({ run_id: "r2", topic_batch_id: "b1" }),
      mkRun({ run_id: "r3" }), // standalone
    ];

    const board = buildBoard(runs, batches, ALL, new Set());

    expect(board.themes).toHaveLength(1);
    expect(board.themes[0].children.map((r) => r.run_id)).toEqual(["r1", "r2"]);
    expect(board.standalone.map((r) => r.run_id)).toEqual(["r3"]);
  });

  it("nests BOTH create- and refresh-promoted runs (linked only by batch id)", () => {
    const batches = [mkBatch({ batch_id: "b1" })];
    const runs = [
      mkRun({ run_id: "create", topic_batch_id: "b1", start_mode: "create" }),
      mkRun({ run_id: "refresh", topic_batch_id: "b1", start_mode: "refresh" }),
    ];

    const board = buildBoard(runs, batches, ALL, new Set());

    expect(board.themes[0].children.map((r) => r.run_id).sort()).toEqual(["create", "refresh"]);
    expect(board.standalone).toHaveLength(0);
  });

  it("shows empty / not-yet-promoted themes when no filters are active", () => {
    const batches = [mkBatch({ batch_id: "empty" })];
    const board = buildBoard([], batches, ALL, new Set());
    expect(board.themes).toHaveLength(1);
    expect(board.themes[0].children).toHaveLength(0);
  });

  it("hides themes with no matching children under a status tab", () => {
    const batches = [mkBatch({ batch_id: "b1" })];
    const runs = [mkRun({ run_id: "r1", topic_batch_id: "b1", status: "published" })];
    const board = buildBoard(runs, batches, { ...ALL, tab: "failed" }, new Set());
    expect(board.themes).toHaveLength(0);
    expect(board.standalone).toHaveLength(0);
  });

  it("surfaces a theme (and its runs) when the search matches the theme title", () => {
    const batches = [mkBatch({ batch_id: "b1", research_theme: "Mpox outbreak" })];
    // Child topic does NOT contain the query — only the theme title does.
    const runs = [mkRun({ run_id: "r1", topic_batch_id: "b1", topic: "Vaccination guide" })];

    const board = buildBoard(runs, batches, { ...ALL, search: "mpox" }, new Set());

    expect(board.themes).toHaveLength(1);
    expect(board.themes[0].matchedByTitle).toBe(true);
    expect(board.themes[0].children.map((r) => r.run_id)).toEqual(["r1"]);
  });

  it("only counts expanded themes' children in visibleRuns", () => {
    const batches = [mkBatch({ batch_id: "b1" }), mkBatch({ batch_id: "b2" })];
    const runs = [
      mkRun({ run_id: "r1", topic_batch_id: "b1" }),
      mkRun({ run_id: "r2", topic_batch_id: "b2" }),
      mkRun({ run_id: "r3" }),
    ];

    const collapsed = buildBoard(runs, batches, ALL, new Set());
    expect(collapsed.visibleRuns.map((r) => r.run_id)).toEqual(["r3"]); // only standalone

    const oneOpen = buildBoard(runs, batches, ALL, new Set(["b1"]));
    expect(oneOpen.visibleRuns.map((r) => r.run_id)).toEqual(["r1", "r3"]);
  });

  it("interleaves themes and standalone runs chronologically (themes not pinned on top)", () => {
    const batches = [mkBatch({ batch_id: "bMid", created_at: "2026-06-05T00:00:00Z" })];
    const runs = [
      mkRun({ run_id: "rNew", created_at: "2026-06-10T00:00:00Z" }),
      mkRun({ run_id: "rOld", created_at: "2026-06-01T00:00:00Z" }),
    ];
    const ids = (b: ReturnType<typeof buildBoard>) =>
      b.items.map((it) => (it.kind === "theme" ? it.group.batch.batch_id : it.run.run_id));

    expect(ids(buildBoard(runs, batches, ALL, new Set()))).toEqual(["rNew", "bMid", "rOld"]);
    expect(ids(buildBoard(runs, batches, { ...ALL, sort: "oldest" }, new Set()))).toEqual([
      "rOld",
      "bMid",
      "rNew",
    ]);
  });

  it("sorts standalone runs by created_at per the sort order", () => {
    const runs = [
      mkRun({ run_id: "old", created_at: "2026-06-01T00:00:00Z" }),
      mkRun({ run_id: "new", created_at: "2026-06-10T00:00:00Z" }),
    ];
    expect(buildBoard(runs, [], ALL, new Set()).standalone.map((r) => r.run_id)).toEqual([
      "new",
      "old",
    ]);
    expect(
      buildBoard(runs, [], { ...ALL, sort: "oldest" }, new Set()).standalone.map((r) => r.run_id),
    ).toEqual(["old", "new"]);
  });
});

describe("summarizeChildren", () => {
  it("buckets children by coarse lifecycle", () => {
    const children = [
      mkRun({ run_id: "1", status: "published" }),
      mkRun({ run_id: "2", status: "published" }),
      mkRun({ run_id: "3", status: "hitl_2" }),
      mkRun({ run_id: "4", status: "failed" }),
      mkRun({ run_id: "5", status: "production" }),
    ];
    expect(summarizeChildren(children)).toEqual({
      total: 5,
      published: 2,
      needsReview: 1,
      failed: 1,
      inFlight: 1,
    });
  });
});
