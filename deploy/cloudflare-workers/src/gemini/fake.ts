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
  readonly calls: RecordedCall[] = [];

  constructor(cannedResponses: Record<string, Record<string, unknown>>) {
    this.canned = { ...cannedResponses };
  }

  async generate(opts: GenerateOptions): Promise<GeminiResult> {
    const { agent, systemPrompt, userPrompt, tools } = opts;

    this.calls.push({ agent, systemPrompt, userPrompt, tools });

    const parsed = this.canned[agent];
    if (parsed === undefined) {
      throw new Error(`No canned response for agent=${agent}`);
    }

    return {
      parsed,
      rawText: JSON.stringify(parsed),
      tokensIn: FAKE_TOKENS_IN,
      tokensOut: FAKE_TOKENS_OUT,
      thinkingTokens: FAKE_THINKING_TOKENS,
      latencyMs: FAKE_LATENCY_MS,
      groundingChunks: null,
      finishReason: null,
    };
  }
}
