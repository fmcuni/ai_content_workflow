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
function fakeLangfuse(
  overrides: Partial<Record<"generation" | "trace" | "flushAsync" | "shutdownAsync", unknown>> = {},
): {
  client: Langfuse;
  trace: ReturnType<typeof vi.fn>;
  generation: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  flushAsync: ReturnType<typeof vi.fn>;
  shutdownAsync: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn();
  const trace = (overrides.trace as ReturnType<typeof vi.fn>) ?? vi.fn(() => ({}));
  const generation =
    (overrides.generation as ReturnType<typeof vi.fn>) ?? vi.fn(() => ({ end }));
  const flushAsync =
    (overrides.flushAsync as ReturnType<typeof vi.fn>) ?? vi.fn(async () => undefined);
  // flushLangfuse uses shutdownAsync (flushes AND awaits in-flight ingestion).
  const shutdownAsync =
    (overrides.shutdownAsync as ReturnType<typeof vi.fn>) ?? vi.fn(async () => undefined);
  const client = { trace, generation, flushAsync, shutdownAsync } as unknown as Langfuse;
  return { client, trace, generation, end, flushAsync, shutdownAsync };
}

const RECORD: GenerationRecord = {
  agent: "writer",
  model: "gemini-3.1-pro-preview",
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
    const { client, trace, generation, end } = fakeLangfuse();

    emitGeneration(client, RECORD);

    // Upserts the trace (keyed on runId) so the run shows in the Traces view.
    expect(trace).toHaveBeenCalledTimes(1);
    expect(trace.mock.calls[0]![0]).toMatchObject({ id: "run-abc" });
    expect(generation).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);

    const arg = generation.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.name).toBe("writer");
    // model drives Langfuse model analytics + automatic cost calculation.
    expect(arg.model).toBe("gemini-3.1-pro-preview");
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

  it("names the trace by topic + short run id and tags it by mode + voice", () => {
    const { client, trace } = fakeLangfuse();

    emitGeneration(client, { ...RECORD, traceMeta: { topic: "兒童手足口病", startMode: "refresh" } });

    const arg = trace.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.id).toBe("run-abc");
    expect(arg.name).toBe("兒童手足口病 · run-abc"); // runId is < 8 chars, so the full id shows
    expect(arg.tags).toEqual(expect.arrayContaining(["refresh", "bowtie"]));
    expect(arg.metadata).toMatchObject({ runId: "run-abc", topic: "兒童手足口病", startMode: "refresh" });
  });

  it("falls back to a run-id trace name when no topic is provided", () => {
    const { client, trace } = fakeLangfuse();

    emitGeneration(client, { ...RECORD, traceMeta: undefined });

    const arg = trace.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.name).toBe("run · run-abc");
  });

  it("omits prompt metadata and traceId when not provided", () => {
    const { client, trace, generation } = fakeLangfuse();

    emitGeneration(client, { ...RECORD, runId: undefined, promptMeta: undefined });

    // No runId → no trace to key on, so the upsert is skipped.
    expect(trace).not.toHaveBeenCalled();
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

  it("calls shutdownAsync on a real client (flushes AND awaits delivery)", async () => {
    const { client, shutdownAsync } = fakeLangfuse();
    await flushLangfuse(client);
    expect(shutdownAsync).toHaveBeenCalledTimes(1);
  });

  it("swallows flush errors (never propagates)", async () => {
    const { client } = fakeLangfuse({
      shutdownAsync: vi.fn(async () => {
        throw new Error("flush failed");
      }),
    });
    await expect(flushLangfuse(client)).resolves.toBeUndefined();
  });

  it("does not hang when shutdownAsync never settles (bounded by timeout)", async () => {
    // Reproduces what broke prod: a host that accepts the connection but never
    // responds leaves shutdownAsync pending forever. flushLangfuse must still
    // resolve so the DO's waitUntil cannot hold a run open past its time limit.
    vi.useFakeTimers();
    try {
      const { client } = fakeLangfuse({
        shutdownAsync: vi.fn(() => new Promise<void>(() => undefined)), // never settles
      });
      const flushPromise = flushLangfuse(client);
      await vi.advanceTimersByTimeAsync(10_000); // past FLUSH_TIMEOUT_MS
      await expect(flushPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
