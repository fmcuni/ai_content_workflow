import { describe, expect, it } from "vitest";

import {
  classifyNodeId,
  contextId,
  gateId,
  partialId,
  VOICE_SETTINGS_ID,
} from "./node-id";

describe("node-id constructors", () => {
  it("mint and classify round-trip for gate, partial, and context ids", () => {
    expect(classifyNodeId(gateId("HITL_1"))).toEqual({ kind: "gate", id: "HITL_1" });
    expect(classifyNodeId(partialId("persona_block"))).toEqual({
      kind: "partial",
      templateId: "persona_block",
    });
    expect(classifyNodeId(contextId("locale"))).toEqual({ kind: "context", tab: "locale" });
    expect(classifyNodeId(contextId("source_policy"))).toEqual({
      kind: "context",
      tab: "source_policy",
    });
  });
});

describe("classifyNodeId", () => {
  it("classifies the voice-settings sentinel", () => {
    expect(classifyNodeId(VOICE_SETTINGS_ID)).toEqual({ kind: "voice-settings" });
  });

  it("falls through to agent for a bare node id", () => {
    expect(classifyNodeId("writer")).toEqual({ kind: "agent", id: "writer" });
  });

  it("keeps a colon in a gate/partial suffix intact", () => {
    expect(classifyNodeId("gate:a:b")).toEqual({ kind: "gate", id: "a:b" });
    expect(classifyNodeId("partial:x:y")).toEqual({ kind: "partial", templateId: "x:y" });
  });
});
