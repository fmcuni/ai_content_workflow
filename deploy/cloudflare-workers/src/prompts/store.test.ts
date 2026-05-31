/**
 * Unit tests for src/prompts/store.ts
 *
 * All tests use an in-memory Map snapshot — no DB required.
 */

import { describe, it, expect } from "vitest";
import {
  resolveBody,
  assembleFromSnapshot,
  assembleWithOverride,
  substitute,
  PromptTemplateNotFound,
} from "./store";
import type { PromptTemplateRow } from "./store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(template_id: string, body: string): PromptTemplateRow {
  return {
    template_id,
    category: "partial",
    filename: `${template_id}.md`,
    body,
    sha256: "deadbeef",
    bytes: body.length,
    updated_at: "2026-05-31T00:00:00Z",
    updated_by: null,
  };
}

// ---------------------------------------------------------------------------
// resolveBody tests
// ---------------------------------------------------------------------------

describe("resolveBody", () => {
  it("resolves a simple include", () => {
    // Arrange
    const snap = new Map([
      ["main", row("main", "Hello {{include:_greeting}} world")],
      ["_greeting", row("_greeting", "beautiful")],
    ]);

    // Act
    const result = resolveBody(snap.get("main")!.body, snap);

    // Assert
    expect(result).toBe("Hello beautiful world");
  });

  it("resolves nested includes and strips trailing newlines from partials", () => {
    // Arrange: _inner is included by _outer which is included by top-level.
    // Trailing newlines on partials must be stripped before inlining; the
    // top-level trailing newline must be preserved.
    const snap = new Map([
      ["agent_writer", row("agent_writer", "Intro\n{{include:_outer}}\nOutro\n")],
      ["_outer", row("_outer", "outer-start\n{{include:_inner}}\nouter-end\n\n")],
      ["_inner", row("_inner", "inner-content\n\n")],
    ]);

    // Act
    const result = assembleFromSnapshot("agent_writer", snap);

    // Assert — partials have trailing \n stripped; top-level trailing \n intact
    // _inner body after strip: "inner-content"
    // _outer body after strip: "outer-start\ninner-content\nouter-end"
    // top-level: "Intro\nouter-start\ninner-content\nouter-end\nOutro\n"
    expect(result).toBe("Intro\nouter-start\ninner-content\nouter-end\nOutro\n");
  });

  it("throws PromptTemplateNotFound for unknown include name", () => {
    // Arrange
    const snap = new Map([
      ["main", row("main", "Start {{include:_missing}} end")],
    ]);

    // Act & Assert
    expect(() => resolveBody(snap.get("main")!.body, snap)).toThrow(
      PromptTemplateNotFound,
    );
    expect(() => resolveBody(snap.get("main")!.body, snap)).toThrow("_missing");
  });

  it("throws on include cycle", () => {
    // Arrange: a → b → a
    const snap = new Map([
      ["a", row("a", "{{include:b}}")],
      ["b", row("b", "{{include:a}}")],
    ]);

    // Act & Assert
    expect(() => resolveBody(snap.get("a")!.body, snap)).toThrow(
      /prompt include cycle/,
    );
  });
});

// ---------------------------------------------------------------------------
// assembleWithOverride tests
// ---------------------------------------------------------------------------

describe("assembleWithOverride", () => {
  it("slots an unsaved partial draft in place of the named partial", () => {
    // Arrange
    const snap = new Map([
      ["agent_main", row("agent_main", "Before\n{{include:_brand}}\nAfter\n")],
      ["_brand", row("_brand", "original brand block\n")],
    ]);

    // Act — override _brand with a draft body
    const result = assembleWithOverride("agent_main", snap, {
      overrideName: "_brand",
      overrideBody: "draft brand block\n",
    });

    // Assert — override body used; its trailing \n stripped before inlining
    expect(result).toBe("Before\ndraft brand block\nAfter\n");
  });
});

// ---------------------------------------------------------------------------
// substitute tests
// ---------------------------------------------------------------------------

describe("substitute", () => {
  it("replaces known placeholders and leaves unknown ones intact", () => {
    const result = substitute("Hello {name}, your topic is {topic} and {unknown}.", {
      name: "Franco",
      topic: "insurance",
    });
    expect(result).toBe("Hello Franco, your topic is insurance and {unknown}.");
  });
});
