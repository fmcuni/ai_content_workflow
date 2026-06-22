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
  assembleWithOverrides,
  voiceView,
  substitute,
  SHARED_VOICE,
  PromptTemplateNotFound,
} from "./store";
import type { PromptTemplateRow } from "./store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(template_id: string, body: string): PromptTemplateRow {
  return vrow(SHARED_VOICE, template_id, body);
}

/** A row for a specific voice + category (defaults to partial). */
function vrow(
  voice_slug: string,
  template_id: string,
  body: string,
  category: string = "partial",
): PromptTemplateRow {
  return {
    voice_slug,
    template_id,
    category,
    filename: `${template_id}.md`,
    body,
    sha256: "deadbeef",
    bytes: body.length,
    updated_at: "2026-05-31T00:00:00Z",
    updated_by: null,
  };
}

/** Build a `(voice, id)`-keyed snapshot the way the store's cache does. The
 * exact key string is irrelevant to `voiceView` (it iterates values), so a
 * readable composite is used here. */
function snapshotOf(rows: PromptTemplateRow[]): Map<string, PromptTemplateRow> {
  const map = new Map<string, PromptTemplateRow>();
  for (const r of rows) map.set(`${r.voice_slug}::${r.template_id}`, r);
  return map;
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
// assembleWithOverrides (multi-override) tests
// ---------------------------------------------------------------------------

describe("assembleWithOverrides", () => {
  it("slots multiple unsaved partial drafts in one assembly", () => {
    // Arrange
    const snap = new Map([
      ["agent_main", row("agent_main", "{{include:_brand}}\n{{include:_seo}}\n")],
      ["_brand", row("_brand", "stored brand\n")],
      ["_seo", row("_seo", "stored seo\n")],
    ]);

    // Act
    const result = assembleWithOverrides(
      "agent_main",
      snap,
      new Map([
        ["_brand", "draft brand\n"],
        ["_seo", "draft seo\n"],
      ]),
    );

    // Assert — both overrides applied; trailing \n stripped per partial
    expect(result).toBe("draft brand\ndraft seo\n");
  });

  it("resolves nested includes inside an override body, honouring the map", () => {
    // Arrange — agent includes _brand; the _brand DRAFT itself includes _seo
    const snap = new Map([
      ["agent_main", row("agent_main", "{{include:_brand}}\n")],
      ["_brand", row("_brand", "stored brand\n")],
      ["_seo", row("_seo", "stored seo\n")],
    ]);

    // Act — override _brand with a body that nests {{include:_seo}}, and also
    // override _seo so the nested include reflects its own draft
    const result = assembleWithOverrides(
      "agent_main",
      snap,
      new Map([
        ["_brand", "draft brand\n{{include:_seo}}\n"],
        ["_seo", "draft seo\n"],
      ]),
    );

    // Assert — nested include resolved from the override map (not the snapshot)
    expect(result).toBe("draft brand\ndraft seo\n");
  });

  it("override body wins over the stored partial (precedence)", () => {
    // Arrange
    const snap = new Map([
      ["agent_main", row("agent_main", "{{include:_brand}}\n")],
      ["_brand", row("_brand", "stored brand\n")],
    ]);

    // Act
    const result = assembleWithOverrides(
      "agent_main",
      snap,
      new Map([["_brand", "draft wins\n"]]),
    );

    // Assert
    expect(result).toBe("draft wins\n");
  });

  it("an empty override map is byte-identical to assembleFromSnapshot", () => {
    // Arrange
    const snap = new Map([
      ["agent_main", row("agent_main", "Before\n{{include:_brand}}\nAfter\n")],
      ["_brand", row("_brand", "stored brand\n")],
    ]);

    // Act
    const withEmpty = assembleWithOverrides("agent_main", snap, new Map());
    const stored = assembleFromSnapshot("agent_main", snap);

    // Assert
    expect(withEmpty).toBe(stored);
    expect(withEmpty).toBe("Before\nstored brand\nAfter\n");
  });

  it("unknown include not in the map and not in the snapshot throws", () => {
    // Arrange
    const snap = new Map([["agent_main", row("agent_main", "{{include:_missing}}\n")]]);

    // Act / Assert
    expect(() => assembleWithOverrides("agent_main", snap, new Map())).toThrow(
      PromptTemplateNotFound,
    );
  });

  it("assembleWithOverride shim delegates to assembleWithOverrides", () => {
    // Arrange
    const snap = new Map([
      ["agent_main", row("agent_main", "{{include:_brand}}\n")],
      ["_brand", row("_brand", "stored brand\n")],
    ]);

    // Act
    const viaShim = assembleWithOverride("agent_main", snap, {
      overrideName: "_brand",
      overrideBody: "draft brand\n",
    });
    const viaMap = assembleWithOverrides(
      "agent_main",
      snap,
      new Map([["_brand", "draft brand\n"]]),
    );

    // Assert
    expect(viaShim).toBe(viaMap);
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

// ---------------------------------------------------------------------------
// voiceView — per-voice resolution + voice -> __shared__ fallback
// ---------------------------------------------------------------------------

describe("voiceView", () => {
  it("resolves a voice's own row over the __shared__ fallback", () => {
    // Arrange: voice owns `audit`; only __shared__ owns `_partial`.
    const snap = snapshotOf([
      vrow(SHARED_VOICE, "audit", "shared audit", "agent"),
      vrow("voice-a", "audit", "voice-a audit", "agent"),
      vrow(SHARED_VOICE, "_partial", "shared partial"),
    ]);

    // Act
    const view = voiceView(snap, "voice-a");

    // Assert — own row wins for `audit`; `_partial` falls back to __shared__.
    expect(view.get("audit")?.body).toBe("voice-a audit");
    expect(view.get("audit")?.voice_slug).toBe("voice-a");
    expect(view.get("_partial")?.body).toBe("shared partial");
    expect(view.get("_partial")?.voice_slug).toBe(SHARED_VOICE);
  });

  it("is order-independent — the voice row wins even when listed before shared", () => {
    const snap = snapshotOf([
      vrow("voice-a", "audit", "voice-a audit", "agent"),
      vrow(SHARED_VOICE, "audit", "shared audit", "agent"),
    ]);
    expect(voiceView(snap, "voice-a").get("audit")?.body).toBe("voice-a audit");
  });

  it("excludes rows owned by other voices", () => {
    const snap = snapshotOf([
      vrow(SHARED_VOICE, "audit", "shared audit", "agent"),
      vrow("voice-b", "secret", "voice-b only", "agent"),
    ]);
    const view = voiceView(snap, "voice-a");
    expect(view.has("secret")).toBe(false);
    expect(view.has("audit")).toBe(true);
  });

  it("surfaces shared judges to every voice (judges are global)", () => {
    const snap = snapshotOf([
      vrow(SHARED_VOICE, "writer_judge", "judge body", "judge"),
      vrow("voice-a", "writer_create", "voice writer", "agent"),
    ]);
    const view = voiceView(snap, "voice-a");
    const judge = view.get("writer_judge");
    expect(judge?.category).toBe("judge");
    expect(judge?.voice_slug).toBe(SHARED_VOICE);
  });
});

// ---------------------------------------------------------------------------
// Per-voice assembly — includes resolve within the voice, falling back to shared
// ---------------------------------------------------------------------------

describe("assembleFromSnapshot (per-voice view)", () => {
  it("inlines the voice's own partial over the shared one", () => {
    const snap = snapshotOf([
      vrow(SHARED_VOICE, "writer", "Intro\n{{include:_brand}}\n", "agent"),
      vrow(SHARED_VOICE, "_brand", "shared brand\n"),
      vrow("voice-a", "_brand", "voice-a brand\n"),
    ]);

    const view = voiceView(snap, "voice-a");
    // The agent body falls back to __shared__, but its `_brand` include resolves
    // to the voice's own partial.
    expect(assembleFromSnapshot("writer", view)).toBe("Intro\nvoice-a brand\n");
  });

  it("falls back to the shared partial when the voice has not customised it", () => {
    const snap = snapshotOf([
      vrow(SHARED_VOICE, "writer", "Intro\n{{include:_brand}}\n", "agent"),
      vrow(SHARED_VOICE, "_brand", "shared brand\n"),
    ]);
    const view = voiceView(snap, "voice-a");
    expect(assembleFromSnapshot("writer", view)).toBe("Intro\nshared brand\n");
  });

  it("byte-identical for a voice whose rows mirror __shared__", () => {
    const sharedSnap = snapshotOf([
      vrow(SHARED_VOICE, "writer", "Intro\n{{include:_brand}}\nOutro\n", "agent"),
      vrow(SHARED_VOICE, "_brand", "brand\n"),
    ]);
    // A duplicated voice carries byte-identical copies under its own slug.
    const dupSnap = snapshotOf([
      vrow(SHARED_VOICE, "writer", "Intro\n{{include:_brand}}\nOutro\n", "agent"),
      vrow(SHARED_VOICE, "_brand", "brand\n"),
      vrow("voice-a", "writer", "Intro\n{{include:_brand}}\nOutro\n", "agent"),
      vrow("voice-a", "_brand", "brand\n"),
    ]);
    const sharedOut = assembleFromSnapshot("writer", voiceView(sharedSnap, SHARED_VOICE));
    const voiceOut = assembleFromSnapshot("writer", voiceView(dupSnap, "voice-a"));
    expect(voiceOut).toBe(sharedOut);
  });

  it("throws when neither the voice nor __shared__ has the template", () => {
    const view = voiceView(snapshotOf([vrow(SHARED_VOICE, "other", "x", "agent")]), "voice-a");
    expect(() => assembleFromSnapshot("missing", view)).toThrow(PromptTemplateNotFound);
  });
});
