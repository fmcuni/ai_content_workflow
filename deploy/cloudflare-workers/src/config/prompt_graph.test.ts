/**
 * Unit tests for src/config/prompt_graph.ts — the in-memory PROMPT_GRAPHS
 * registry and its `getPromptGraph` lookup. Pure data, no DB.
 */

import { describe, it, expect } from "vitest";
import { PROMPT_GRAPHS, getPromptGraph } from "./prompt_graph";

describe("getPromptGraph", () => {
  it("returns the refresh graph for mode 'refresh'", () => {
    const g = getPromptGraph("refresh");
    expect(g).not.toBeNull();
    expect(g?.mode).toBe("refresh");
    expect(g?.label).toBe("Rewrite");
  });

  it("returns the create graph for mode 'create'", () => {
    const g = getPromptGraph("create");
    expect(g?.mode).toBe("create");
    expect(g?.label).toBe("Create");
  });

  it("returns the topic_expansion graph for mode 'topic_expansion'", () => {
    const g = getPromptGraph("topic_expansion");
    expect(g?.mode).toBe("topic_expansion");
    expect(g?.label).toBe("Topic Expansion");
  });

  it("returns null for an unknown mode (drives the 404 path)", () => {
    expect(getPromptGraph("nope")).toBeNull();
    expect(getPromptGraph("")).toBeNull();
  });

  it("exposes exactly the three known modes", () => {
    expect(Object.keys(PROMPT_GRAPHS).sort()).toEqual([
      "create",
      "refresh",
      "topic_expansion",
    ]);
  });
});

describe("PROMPT_GRAPHS shape parity", () => {
  it("refresh graph carries the full strategy + production + publish node set", () => {
    const g = getPromptGraph("refresh")!;
    expect(g.nodes.map((n) => n.id)).toEqual([
      "fetch_article",
      "gap_analysis",
      "outline",
      "writer",
      "resolve_citations",
      "render_html",
      "audit",
      "publish",
    ]);
  });

  it("refresh writer node keeps its alt_template_ids", () => {
    const g = getPromptGraph("refresh")!;
    const writer = g.nodes.find((n) => n.id === "writer");
    expect(writer?.system_prompt_template_id).toBe("writer_small_refresh");
    expect(writer?.alt_template_ids).toEqual(["writer_full_rewrite"]);
  });

  it("create graph enters at outline (skips fetch + gap analysis)", () => {
    const g = getPromptGraph("create")!;
    expect(g.nodes[0]?.id).toBe("outline");
    expect(g.nodes.map((n) => n.id)).not.toContain("fetch_article");
    expect(g.nodes.map((n) => n.id)).not.toContain("gap_analysis");
  });

  it("refresh and create share the production gates (HITL_1, HITL_2)", () => {
    const refresh = getPromptGraph("refresh")!;
    const create = getPromptGraph("create")!;
    expect(refresh.gates.map((g) => g.id)).toEqual(["HITL_1", "HITL_2"]);
    expect(create.gates).toEqual(refresh.gates);
  });

  it("topic_expansion ends at the HITL_T1 review gate", () => {
    const g = getPromptGraph("topic_expansion")!;
    expect(g.gates.map((gate) => gate.id)).toEqual(["HITL_T1"]);
    expect(g.gates[0]?.before).toBe("__end__");
  });
});
