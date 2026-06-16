import { describe, expect, it } from "vitest";

import type { PromptGraph } from "@/lib/types";
import { buildStudioGraph, type Ownership, type PartialInfo } from "./layout";

function makeGraph(): PromptGraph {
  return {
    mode: "refresh",
    nodes: [
      {
        id: "gap_analysis",
        sub_graph: "strategy",
        order: 1,
        kind: "llm",
        uses_persona: true,
        system_prompt_template_id: "gap_analysis",
        description: "Find content gaps",
      },
      {
        id: "outline",
        sub_graph: "strategy",
        order: 2,
        kind: "llm",
        uses_persona: true,
        system_prompt_template_id: "outline_rewrite_mode",
        alt_template_ids: ["outline_create_mode"],
        description: "Plan the rewrite",
      },
      {
        id: "writer",
        sub_graph: "production",
        order: 1,
        kind: "llm",
        uses_persona: true,
        system_prompt_template_id: "writer",
        description: "Draft the article",
      },
      {
        id: "audit",
        sub_graph: "production",
        order: 2,
        kind: "llm",
        uses_persona: false,
        system_prompt_template_id: "audit",
        description: "Review the draft",
      },
      {
        id: "render_html",
        sub_graph: "production",
        order: 3,
        kind: "deterministic",
        uses_persona: false,
        system_prompt_template_id: null,
        description: "Serialize to HTML",
      },
    ],
    edges: [
      { from: "gap_analysis", to: "outline" },
      { from: "outline", to: "writer" },
      { from: "writer", to: "audit" },
      { from: "audit", to: "writer" }, // refine loop-back
      { from: "audit", to: "render_html" },
    ],
    gates: [
      { id: "HITL_1", before: "writer", label: "HITL 1", description: "Approve outline" },
      { id: "HITL_T1", before: "__end__", label: "Topic review", description: "Review topics" },
    ],
  };
}

const OWNERSHIP: Record<string, Ownership> = {
  gap_analysis: "overridden",
  outline_rewrite_mode: "shared",
  writer: "shared",
  audit: "shared",
};

const PARTIALS: PartialInfo[] = [
  { templateId: "persona_block", consumers: ["writer", "outline"], ownership: "shared" },
  // consumer not in this mode's graph → must be filtered out
  { templateId: "orphan_partial", consumers: ["nonexistent_node"], ownership: "shared" },
];

describe("buildStudioGraph", () => {
  it("lays agents left→right by sub-graph rank then order", () => {
    const { nodes } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const agents = nodes.filter((n) => n.type === "agent");
    const ids = agents.map((n) => n.id);
    expect(ids).toEqual(["gap_analysis", "outline", "writer", "audit", "render_html"]);
    // x increases by a fixed gap; all on the spine (y = 0).
    expect(agents[0].position.x).toBe(0);
    expect(agents[1].position.x).toBeGreaterThan(agents[0].position.x);
    expect(agents.every((n) => n.position.y === 0)).toBe(true);
  });

  it("marks ownership: own row → overridden, null template → none, else shared", () => {
    const { nodes } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect((byId.gap_analysis.data as { ownership: Ownership }).ownership).toBe("overridden");
    expect((byId.writer.data as { ownership: Ownership }).ownership).toBe("shared");
    expect((byId.render_html.data as { ownership: Ownership }).ownership).toBe("none");
  });

  it("styles a backward edge as the rust refine loop", () => {
    const { edges } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const loop = edges.find((e) => e.id === "spine:audit->writer");
    expect(loop).toBeDefined();
    expect(loop?.animated).toBe(true);
    expect(loop?.label).toBe("refine loop");
    const forward = edges.find((e) => e.id === "spine:outline->writer");
    expect(forward?.animated).toBe(false);
  });

  it("anchors an in-graph gate above its node and trails an __end__ gate", () => {
    const { nodes, edges } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const anchored = nodes.find((n) => n.id === "gate:HITL_1");
    const trailing = nodes.find((n) => n.id === "gate:HITL_T1");
    expect(anchored?.position.y).toBeLessThan(0); // floats above the spine
    expect(trailing?.position.y).toBe(0); // trails on the spine
    // The anchored gate gets a connector edge; the trailing one does not.
    expect(edges.some((e) => e.id === "gate-edge:HITL_1")).toBe(true);
    expect(edges.some((e) => e.id === "gate-edge:HITL_T1")).toBe(false);
  });

  it("shows only partials with an in-graph consumer and draws include-edges", () => {
    const { nodes, edges } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const partialNodes = nodes.filter((n) => n.type === "partial");
    expect(partialNodes.map((n) => n.id)).toEqual(["partial:persona_block"]);
    expect((partialNodes[0].data as { consumerCount: number }).consumerCount).toBe(2);
    const includeEdges = edges.filter((e) => e.id.startsWith("inc:"));
    expect(includeEdges.map((e) => e.id).sort()).toEqual([
      "inc:persona_block->outline",
      "inc:persona_block->writer",
    ]);
  });
});
