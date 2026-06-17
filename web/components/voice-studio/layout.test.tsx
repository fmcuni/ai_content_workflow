import { describe, expect, it } from "vitest";

import type { PromptGraph } from "@/lib/types";
import { buildStudioGraph, type Ownership, type PartialInfo } from "./layout";
import type { NodeRunStatus, RunOverlay } from "./run-overlay";

function makeGraph(): PromptGraph {
  return {
    mode: "refresh",
    nodes: [
      {
        id: "gap_analysis",
        sub_graph: "strategy",
        order: 1,
        kind: "llm",
        // LLM but no persona block — locale tokens still reach it, source policy does not.
        uses_persona: false,
        system_prompt_template_id: "gap_analysis",
        description: "Find content gaps",
      },
      {
        id: "outline",
        sub_graph: "strategy",
        order: 2,
        kind: "llm",
        uses_persona: false,
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
        uses_persona: true,
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
  // Consumers come from the API as *template ids*: "writer" is the writer
  // node's system template; "outline_create_mode" is the outline node's alt
  // template. Both must resolve back to their node ids.
  { templateId: "persona_block", consumers: ["writer", "outline_create_mode"], ownership: "shared" },
  // consumer template not in this mode's graph → must be filtered out
  { templateId: "orphan_partial", consumers: ["nonexistent_template"], ownership: "shared" },
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

  it("routes a backward edge under the spine via bottom handles as the rust refine loop", () => {
    const { edges } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const loop = edges.find((e) => e.id === "spine:audit->writer");
    expect(loop).toBeDefined();
    expect(loop?.animated).toBe(true);
    expect(loop?.label).toBe("refine loop");
    // Loop-backs leave/enter via the card bottoms (so they bow below the spine
    // instead of cutting straight across it) and use orthogonal routing.
    expect(loop?.sourceHandle).toBe("loop-out");
    expect(loop?.targetHandle).toBe("loop-in");
    expect(loop?.type).toBe("smoothstep");
    const forward = edges.find((e) => e.id === "spine:outline->writer");
    expect(forward?.animated).toBe(false);
    // Forward edges stay on the left/right spine handles.
    expect(forward?.sourceHandle).toBe("out");
  });

  it("places an in-graph gate inline on the spine and wires it into the flow", () => {
    const { nodes, edges } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const anchored = nodes.find((n) => n.id === "gate:HITL_1");
    const trailing = nodes.find((n) => n.id === "gate:HITL_T1");
    const writer = nodes.find((n) => n.id === "writer");
    const outline = nodes.find((n) => n.id === "outline");
    expect(anchored).toBeDefined();
    expect(trailing).toBeDefined();
    // The gate takes its own column between the node it guards (writer) and that
    // node's predecessor (outline): outline.x < gate.x < writer.x.
    expect(outline!.position.x).toBeLessThan(anchored!.position.x);
    expect(anchored!.position.x).toBeLessThan(writer!.position.x);
    // The forward edge into the guarded node routes through the gate, and the
    // gate continues to the node — both solid spine edges.
    expect(edges.find((e) => e.id === "spine:outline->writer")?.target).toBe("gate:HITL_1");
    expect(edges.find((e) => e.id === "gate-out:HITL_1")?.target).toBe("writer");
    // The loop-back edge bypasses the gate (no re-review on internal refine).
    expect(edges.find((e) => e.id === "spine:audit->writer")?.target).toBe("writer");
    // The trailing gate is wired from the last agent; no legacy floating
    // dashed connector survives.
    expect(edges.some((e) => e.id === "gate-in:HITL_T1")).toBe(true);
    expect(edges.some((e) => e.id.startsWith("gate-edge:"))).toBe(false);
  });

  it("renders every shared partial and draws include-edges only to in-graph consumers", () => {
    const { nodes, edges } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const partialNodes = nodes.filter((n) => n.type === "partial");
    const consumerCountById = Object.fromEntries(
      partialNodes.map((n) => [n.id, (n.data as { consumerCount: number }).consumerCount]),
    );
    // Both partials show — including orphan_partial, whose only consumer is not
    // in this mode's graph (e.g. a voice whose prompt drifted off the include).
    expect(partialNodes.map((n) => n.id).sort()).toEqual([
      "partial:orphan_partial",
      "partial:persona_block",
    ]);
    expect(consumerCountById["partial:persona_block"]).toBe(2);
    expect(consumerCountById["partial:orphan_partial"]).toBe(0);
    // Edges are drawn only to consumers that exist in this mode's graph; the
    // unwired partial dangles without edges rather than disappearing.
    const includeEdges = edges.filter((e) => e.id.startsWith("inc:"));
    expect(includeEdges.map((e) => e.id).sort()).toEqual([
      "inc:persona_block->outline",
      "inc:persona_block->writer",
    ]);
  });

  it("injects locale into every LLM agent and source-policy into persona agents", () => {
    const { nodes, edges } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const contextNodes = nodes.filter((n) => n.type === "context");
    expect(contextNodes.map((n) => n.id).sort()).toEqual([
      "context:locale",
      "context:source_policy",
    ]);
    const targetsFor = (prefix: string) =>
      edges
        .filter((e) => e.id.startsWith(prefix))
        .map((e) => e.target)
        .sort();
    // Locale reaches every LLM prompt — including the non-persona gap_analysis +
    // outline (the connection this adds) — but not the deterministic render_html.
    expect(targetsFor("inject:context:locale->")).toEqual([
      "audit",
      "gap_analysis",
      "outline",
      "writer",
    ]);
    // Source policy only lands in the persona/citation agents.
    expect(targetsFor("inject:context:source_policy->")).toEqual(["audit", "writer"]);
    const localeNode = contextNodes.find((n) => n.id === "context:locale");
    expect((localeNode!.data as { injectCount: number }).injectCount).toBe(4);
    const injectEdges = edges.filter((e) => e.id.startsWith("inject:"));
    expect(injectEdges.every((e) => e.targetHandle === "inject")).toBe(true);
  });

  it("drops a context input that has no target agent in this mode", () => {
    const g = makeGraph();
    // No persona anywhere → source policy has no target and is dropped; locale
    // still wires to the LLM agents.
    const noPersona: PromptGraph = {
      ...g,
      nodes: g.nodes.map((n) => ({ ...n, uses_persona: false })),
    };
    const np = buildStudioGraph(noPersona, PARTIALS, OWNERSHIP);
    expect(np.nodes.some((n) => n.id === "context:source_policy")).toBe(false);
    expect(np.nodes.some((n) => n.id === "context:locale")).toBe(true);
    // No LLM agents either → both context inputs dropped, no inject edge dangles.
    const allDeterministic: PromptGraph = {
      ...g,
      nodes: g.nodes.map((n) => ({ ...n, uses_persona: false, kind: "deterministic" })),
    };
    const det = buildStudioGraph(allDeterministic, PARTIALS, OWNERSHIP);
    expect(det.nodes.some((n) => n.type === "context")).toBe(false);
    expect(det.edges.some((e) => e.id.startsWith("inject:"))).toBe(false);
  });

  it("hides the partial library in topic-expansion mode", () => {
    const g: PromptGraph = { ...makeGraph(), mode: "topic_expansion" };
    const { nodes, edges } = buildStudioGraph(g, PARTIALS, OWNERSHIP);
    expect(nodes.some((n) => n.type === "partial")).toBe(false);
    expect(edges.some((e) => e.id.startsWith("inc:"))).toBe(false);
  });

  it("stacks a consumed partial under the agent that includes it", () => {
    const { nodes } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP);
    const writer = nodes.find((n) => n.id === "writer")!;
    const persona = nodes.find((n) => n.id === "partial:persona_block")!;
    // persona_block's primary consumer is writer → it sits in writer's column,
    // below the spine, so its include-edge is a short near-vertical line.
    expect(Math.abs(persona.position.x - writer.position.x)).toBeLessThan(40);
    expect(persona.position.y).toBeGreaterThan(writer.position.y);
  });

  it("leaves every agent runStatus undefined when the overlay's mode doesn't match", () => {
    const overlay: RunOverlay = {
      modeMatches: false,
      ranAtAll: true,
      byNode: { writer: { kind: "ran", executions: 2 } },
    };
    const { nodes } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP, overlay);
    const agents = nodes.filter((n) => n.type === "agent");
    const statuses = agents.map((n) => (n.data as { runStatus?: NodeRunStatus }).runStatus);
    expect(statuses.every((s) => s === undefined)).toBe(true);
  });

  it("tags ran nodes and marks in-mode absentees as did-not-run when the mode matches", () => {
    const overlay: RunOverlay = {
      modeMatches: true,
      ranAtAll: true,
      byNode: {
        gap_analysis: { kind: "ran", executions: 1 },
        writer: { kind: "ran", executions: 2 },
      },
    };
    const { nodes } = buildStudioGraph(makeGraph(), PARTIALS, OWNERSHIP, overlay);
    const runStatusOf = (id: string) =>
      (nodes.find((n) => n.id === id)?.data as { runStatus?: NodeRunStatus }).runStatus;
    expect(runStatusOf("gap_analysis")).toEqual({ kind: "ran", executions: 1 });
    expect(runStatusOf("writer")).toEqual({ kind: "ran", executions: 2 });
    // outline lives in this mode's graph but is absent from the log → did-not-run.
    expect(runStatusOf("outline")).toEqual({ kind: "did-not-run" });
  });
});
