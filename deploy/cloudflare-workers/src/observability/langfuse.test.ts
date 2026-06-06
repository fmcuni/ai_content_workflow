import { describe, expect, it, vi } from "vitest";

import {
  emitGeneration,
  flushLangfuse,
  isLangfuseEnabled,
  type GenerationRecord,
  type LangfuseEnv,
} from "./langfuse";
import type { Langfuse } from "langfuse";

// A spy that records the args passed to `generation()` and whether `.end()` was
// called. Cast to Langfuse — we only exercise the two methods our code touches,
// so a structural fake keeps the test free of the real (network) SDK.
function fakeLangfuse(overrides: Partial<Record<"generation" | "flushAsync", unknown>> = {}): {
  client: Langfuse;
  generation: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  flushAsync: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn();
  const generation =
    (overrides.generation as ReturnType<typeof vi.fn>) ?? vi.fn(() => ({ end }));
  const flushAsync =
    (overrides.flushAsync as ReturnType<typeof vi.fn>) ?? vi.fn(async () => undefined);
  const client = { generation, flushAsync } as unknown as Langfuse;
  return { client, generation, end, flushAsync };
}

const RECORD: GenerationRecord = {
  agent: "writer",
  systemPrompt: "you are a writer",
  userPrompt: "write about X",
  rawText: "<h1>X</h1>",
  parsed: { html: "<h1>X</h1>" },
  tokensIn: 100,
  tokensOut: 50,
  thinkingTokens: 25,
  latencyMs: 1234,
  finishReason: "STOP",
  runId: "run-abc",
  promptMeta: { voiceSlug: "bowtie", templateId: "writer", sha256: "deadbeef" },
};

describe("isLangfuseEnabled", () => {
  const KEYS: LangfuseEnv = { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" };

  it("is OFF when the flag is unset (default)", () => {
    expect(isLangfuseEnabled({ ...KEYS })).toBe(false);
  });

  it("is OFF for falsey flag values", () => {
    for (const v of ["false", "0", "off", "no", ""]) {
      expect(isLangfuseEnabled({ ...KEYS, LANGFUSE_ENABLED: v })).toBe(false);
    }
  });

  it("is ON for truthy flag values when both keys are present", () => {
    for (const v of ["true", "1", "on", "yes", "TRUE", " On "]) {
      expect(isLangfuseEnabled({ ...KEYS, LANGFUSE_ENABLED: v })).toBe(true);
    }
  });

  it("is OFF when enabled but a key is missing", () => {
    expect(isLangfuseEnabled({ LANGFUSE_ENABLED: "true", LANGFUSE_PUBLIC_KEY: "pk" })).toBe(false);
    expect(isLangfuseEnabled({ LANGFUSE_ENABLED: "true", LANGFUSE_SECRET_KEY: "sk" })).toBe(false);
    expect(isLangfuseEnabled({ LANGFUSE_ENABLED: "true" })).toBe(false);
  });
});

describe("emitGeneration", () => {
  it("maps the record onto a Langfuse generation and ends it", () => {
    const { client, generation, end } = fakeLangfuse();

    emitGeneration(client, RECORD);

    expect(generation).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);

    const arg = generation.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.name).toBe("writer");
    // runId becomes the trace id so a run's generations group under one trace.
    expect(arg.traceId).toBe("run-abc");
    // Prompts flow one-way into input — never read back / managed by Langfuse.
    expect(arg.input).toEqual({ systemPrompt: "you are a writer", userPrompt: "write about X" });
    expect(arg.output).toEqual({ rawText: "<h1>X</h1>", parsed: { html: "<h1>X</h1>" } });
    // total = in + out + thinking.
    expect(arg.usageDetails).toEqual({ input: 100, output: 50, total: 175 });
    expect(arg.metadata).toEqual({
      latencyMs: 1234,
      finishReason: "STOP",
      templateId: "writer",
      voiceSlug: "bowtie",
      promptSha256: "deadbeef",
      runId: "run-abc",
    });
  });

  it("omits prompt metadata and traceId when not provided", () => {
    const { client, generation } = fakeLangfuse();

    emitGeneration(client, { ...RECORD, runId: undefined, promptMeta: undefined });

    const arg = generation.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.traceId).toBeUndefined();
    expect(arg.metadata).toEqual({ latencyMs: 1234, finishReason: "STOP" });
  });

  it("swallows errors thrown by the client (never propagates)", () => {
    const { client } = fakeLangfuse({
      generation: vi.fn(() => {
        throw new Error("langfuse exploded");
      }),
    });
    expect(() => emitGeneration(client, RECORD)).not.toThrow();
  });
});

describe("flushLangfuse", () => {
  it("is a no-op on a null client", async () => {
    await expect(flushLangfuse(null)).resolves.toBeUndefined();
  });

  it("calls flushAsync on a real client", async () => {
    const { client, flushAsync } = fakeLangfuse();
    await flushLangfuse(client);
    expect(flushAsync).toHaveBeenCalledTimes(1);
  });

  it("swallows flush errors (never propagates)", async () => {
    const { client } = fakeLangfuse({
      flushAsync: vi.fn(async () => {
        throw new Error("flush failed");
      }),
    });
    await expect(flushLangfuse(client)).resolves.toBeUndefined();
  });
});
