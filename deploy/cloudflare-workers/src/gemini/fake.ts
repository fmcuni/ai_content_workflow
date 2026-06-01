/**
 * Fake Gemini client for tests.
 *
 * Ported from `content_tool/gemini/fake.py`. Returns canned responses keyed by
 * `agent` and records every call for assertions.
 */

import type { GeminiClient, GeminiResult, GenerateOptions } from "./types";

const FAKE_TOKENS_IN = 1000;
const FAKE_TOKENS_OUT = 500;
const FAKE_THINKING_TOKENS = 100;
const FAKE_LATENCY_MS = 10;

/** A recorded `generate` call (mirrors the Python `calls` list). */
export interface RecordedCall {
  agent: string;
  systemPrompt: string;
  userPrompt: string;
  tools: string[];
}

export class FakeGeminiClient implements GeminiClient {
  private readonly canned: Record<string, Record<string, unknown>>;
  // Optional per-agent grounding chunks (e.g. for topic_existing_search, which
  // harvests groundingChunks rather than the parsed JSON).
  private readonly cannedGrounding: Record<string, Record<string, unknown>[]>;
  readonly calls: RecordedCall[] = [];

  constructor(
    cannedResponses: Record<string, Record<string, unknown>>,
    cannedGrounding: Record<string, Record<string, unknown>[]> = {},
  ) {
    this.canned = { ...cannedResponses };
    this.cannedGrounding = { ...cannedGrounding };
  }

  async generate(opts: GenerateOptions): Promise<GeminiResult> {
    const { agent, systemPrompt, userPrompt, responseSchema, tools } = opts;

    this.calls.push({ agent, systemPrompt, userPrompt, tools });

    const canned = this.canned[agent];
    // A plain-text call (no schema) need not have a canned JSON body — e.g.
    // topic_existing_search, where only the grounding chunks matter.
    if (canned === undefined && responseSchema !== null) {
      throw new Error(`No canned response for agent=${agent}`);
    }
    const parsed = canned ?? {};

    return {
      parsed,
      rawText: JSON.stringify(parsed),
      tokensIn: FAKE_TOKENS_IN,
      tokensOut: FAKE_TOKENS_OUT,
      thinkingTokens: FAKE_THINKING_TOKENS,
      latencyMs: FAKE_LATENCY_MS,
      groundingChunks: this.cannedGrounding[agent] ?? null,
      finishReason: null,
    };
  }
}
