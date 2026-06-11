import { describe, expect, it } from "vitest";

import {
  buildDeskItems,
  filterByTab,
  runToItem,
  batchToItem,
} from "@/lib/desk-items";
import type { RunStatus, RunSummary, TopicBatch, BatchStatus } from "@/lib/types";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "r1",
    status: "hitl_1",
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

describe("runToItem gate derivation", () => {
  it("maps HITL_1 to a one-click approve_outline gate on the desk", () => {
    const item = runToItem(run({ status: "hitl_1" }));
    expect(item.lane).toBe("desk");
    expect(item.gate).toBe("approve_outline");
    expect(item.action).toBe("Approve outline");
    expect(item.rowHref).toBe("/runs/r1/hitl1");
  });

  it("maps HITL_2 to approve_publish", () => {
    const item = runToItem(run({ status: "hitl_2" }));
    expect(item.gate).toBe("approve_publish");
    expect(item.rowHref).toBe("/runs/r1/hitl2");
  });

  it("maps a failed run to the restart gate", () => {
    const item = runToItem(run({ status: "failed" }));
    expect(item.gate).toBe("restart");
  });

  it.each<[RunStatus]>([
    ["pending"], ["fetching"], ["strategy"], ["production"], ["publishing"], ["revising"],
  ])(
    "treats %s as an in-motion row with no inline gate",
    (status) => {
      const item = runToItem(run({ status }));
      expect(item.lane).toBe("motion");
      expect(item.gate).toBe("open");
      expect(item.action).toBeNull();
    },
  );

  it("classifies a create run under the create category", () => {
    const item = runToItem(run({ start_mode: "create", status: "hitl_1" }));
    expect(item.category).toBe("create");
  });

  it("flags auto-accept runs", () => {
    expect(runToItem(run({ auto_accept_hitl1: true })).autoAccept).toBe(true);
    expect(runToItem(run()).autoAccept).toBe(false);
  });
});

describe("batchToItem", () => {
  it("exposes a promote gate that only navigates (never one-click)", () => {
    const item = batchToItem(batch({ status: "ready_for_review" }));
    expect(item.gate).toBe("promote");
    expect(item.lane).toBe("desk");
    expect(item.rowHref).toBe("/topic-batches/b1");
  });

  it("carries the batch auto-accept default onto the card", () => {
    expect(batchToItem(batch({ auto_accept_hitl1_default: true })).autoAccept).toBe(true);
  });
});

describe("buildDeskItems + filterByTab", () => {
  it("sorts newest-first across runs and batches", () => {
    const items = buildDeskItems(
      [run({ run_id: "old", created_at: "2026-05-01T00:00:00Z" })],
      [batch({ batch_id: "new", created_at: "2026-06-10T00:00:00Z" })],
    );
    expect(items[0].id).toBe("new");
    expect(items[1].id).toBe("old");
  });

  it("filters by tab, with 'all' passing everything", () => {
    const items = buildDeskItems(
      [run({ run_id: "rw", start_mode: "refresh" }), run({ run_id: "cr", start_mode: "create" })],
      [batch()],
    );
    expect(filterByTab(items, "all")).toHaveLength(3);
    expect(filterByTab(items, "rewrite").map((i) => i.id)).toEqual(["rw"]);
    expect(filterByTab(items, "create").map((i) => i.id)).toEqual(["cr"]);
    expect(filterByTab(items, "topic_gen")).toHaveLength(1);
  });
});
