/**
 * Real Gemini client backed by `@google/genai` (TS SDK, v^2.7.0).
 *
 * Ported from `content_tool/gemini/client.py`. The TS SDK uses camelCase
 * config keys, so the Python `response_json_schema` becomes `responseJsonSchema`,
 * `thinking_config` -> `thinkingConfig`, `response_mime_type` -> `responseMimeType`,
 * and tools are `{ googleSearch: {} }` / `{ urlContext: {} }` on a `Tool` object.
 * usageMetadata fields are `promptTokenCount` / `candidatesTokenCount` /
 * `thoughtsTokenCount`.
 */

import { GoogleGenAI } from "@google/genai";
import type {
  GenerateContentConfig,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  Candidate,
  Tool,
  ThinkingLevel,
} from "@google/genai";

import { parseGeminiJson, stripPropertyOrdering } from "./parse";
import type { GeminiClient, GeminiResult, GenerateOptions } from "./types";

const TEMPERATURE = 1.0;
const RESPONSE_MIME_TYPE_JSON = "application/json";

// Gemini occasionally returns an empty / non-JSON HTTP body (safety block,
// truncated stream, 5xx HTML, dropped connection). The @google/genai SDK then
// throws the native `SyntaxError: Unexpected end of JSON input`, which used to
// fail the whole run with that cryptic message. Retry transient cases, and on
// exhaustion rewrap into an actionable GeminiError.
export const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_BACKOFF_MS = [500, 1500];

export class GeminiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GeminiError";
  }
}

function earlyStopMessage(agent: string, finishReason: string | null): string {
  return (
    `${agent}: Gemini stopped early (finishReason=${finishReason}) and returned ` +
    `incomplete JSON — output was truncated or blocked, so no valid structured ` +
    `response is available.`
  );
}

/**
 * Parse a structured-output reply, attributing failures to `agent`.
 *
 * Parse-first: a valid body always succeeds (no false positives). On failure,
 * a `finishReason` other than `STOP`/`null` means Gemini stopped early —
 * `MAX_TOKENS` truncation (long article) or a SAFETY/RECITATION block — so the
 * body is incomplete/empty JSON. Surface that explicitly rather than the cryptic
 * "not valid JSON" message, as a (non-transient) GeminiError so it is never
 * retried — re-running the same prompt just truncates again.
 */
export function parseStructuredResponse(
  agent: string,
  text: string,
  finishReason: string | null,
): Record<string, unknown> {
  const abnormal = finishReason !== null && finishReason !== "STOP";
  let parsed: Record<string, unknown>;
  try {
    parsed = parseGeminiJson(text);
  } catch (err: unknown) {
    if (abnormal) {
      throw new GeminiError(earlyStopMessage(agent, finishReason), { cause: err });
    }
    throw new GeminiError(`${agent}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  // parseGeminiJson returns {} for an empty/whitespace body; under an abnormal
  // finish that empty body is a block/truncation (e.g. SAFETY returns no text),
  // not a valid empty object — surface it as such.
  if (abnormal && Object.keys(parsed).length === 0) {
    throw new GeminiError(earlyStopMessage(agent, finishReason));
  }
  return parsed;
}

/** Heuristic: is this error a transient upstream failure worth retrying? */
export function isTransientGeminiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Empty/truncated JSON body surfaces as a SyntaxError from the SDK's parse.
  if (err.name === "SyntaxError") return true;
  const m = err.message.toLowerCase();
  return (
    m.includes("unexpected end of json") ||
    m.includes("fetch failed") ||
    m.includes("network") ||
    m.includes("terminated") ||
    m.includes("connection") ||
    m.includes("timeout") ||
    m.includes("econn") ||
    /\b(429|500|502|503|504)\b/.test(m)
  );
}

/**
 * Run a Gemini SDK call with bounded retries on transient failures. Deterministic
 * errors (4xx, schema problems) propagate immediately. `backoffMs` is injectable
 * so tests can run with zero delay.
 */
export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  backoffMs: number[] = GEMINI_BACKOFF_MS,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isTransientGeminiError(err)) throw err;
      if (attempt < GEMINI_MAX_ATTEMPTS) {
        const ms = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
        continue;
      }
      throw new GeminiError(
        `Gemini returned an empty/non-JSON response after ${attempt} attempts ` +
          `(likely a transient upstream error). Underlying: ` +
          `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        { cause: err },
      );
    }
  }
}

export interface GeminiClientConfig {
  apiKey: string;
  model: string;
  /** Thinking level, e.g. "HIGH" / "MEDIUM" / "LOW" (the SDK ThinkingLevel enum). */
  thinkingLevel: string;
}

export class RealGeminiClient implements GeminiClient {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly thinkingLevel: string;

  constructor(config: GeminiClientConfig) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.thinkingLevel = config.thinkingLevel;
  }

  async generate(opts: GenerateOptions): Promise<GeminiResult> {
    const { agent, systemPrompt, userPrompt, responseSchema, tools, onThought } = opts;

    const config = this.buildConfig(systemPrompt, responseSchema, tools, onThought !== undefined);

    const startedAt = Date.now();

    const { text, usage, candidate } = await withGeminiRetry(async () => {
      if (onThought !== undefined) {
        const streamed = await this.streamCall(agent, userPrompt, config, onThought);
        return { text: streamed.text, usage: streamed.usage, candidate: streamed.candidate };
      }
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: userPrompt,
        config,
      });
      return {
        text: response.text ?? "",
        usage: response.usageMetadata,
        candidate: response.candidates?.[0],
      };
    });

    const latencyMs = Date.now() - startedAt;
    const finishReason = candidate?.finishReason ?? null;

    // Only parse JSON when the caller actually requested structured output.
    // A null schema means a plain-text reply is expected (e.g. the setup
    // credential check), so forcing JSON parsing there would reject a valid
    // response (commit 563c524). `parsed` stays `{}` in that case.
    // parseStructuredResponse detects MAX_TOKENS truncation / SAFETY blocks and
    // attributes failures to the agent instead of a cryptic parse error.
    const parsed =
      responseSchema !== null ? parseStructuredResponse(agent, text, finishReason) : {};

    return {
      parsed,
      rawText: text,
      tokensIn: usage?.promptTokenCount ?? 0,
      tokensOut: usage?.candidatesTokenCount ?? 0,
      thinkingTokens: usage?.thoughtsTokenCount ?? 0,
      latencyMs,
      groundingChunks: extractGroundingChunks(candidate),
      finishReason,
    };
  }

  private buildConfig(
    systemPrompt: string,
    responseSchema: Record<string, unknown> | null,
    tools: string[],
    includeThoughts: boolean,
  ): GenerateContentConfig {
    const configTools = buildTools(tools);

    const config: GenerateContentConfig = {
      systemInstruction: systemPrompt,
      temperature: TEMPERATURE,
      thinkingConfig: {
        thinkingLevel: this.thinkingLevel as ThinkingLevel,
        // Only request thoughts when a consumer is listening; otherwise we'd
        // charge thought tokens against runs nobody is watching.
        ...(includeThoughts ? { includeThoughts: true } : {}),
      },
    };

    if (responseSchema !== null) {
      config.responseMimeType = RESPONSE_MIME_TYPE_JSON;
      config.responseJsonSchema = stripPropertyOrdering(responseSchema);
    }

    if (configTools.length > 0) {
      config.tools = configTools;
    }

    return config;
  }

  /**
   * Drive `generateContentStream`, forwarding thought parts to `onThought` and
   * accumulating non-thought text plus the final usage/candidate metadata. The
   * SDK surfaces `usageMetadata` and the resolved candidate on the last chunk,
   * so we keep overwriting as each chunk lands.
   */
  private async streamCall(
    agent: string,
    userPrompt: string,
    config: GenerateContentConfig,
    onThought: NonNullable<GenerateOptions["onThought"]>,
  ): Promise<{
    text: string;
    usage: GenerateContentResponseUsageMetadata | undefined;
    candidate: Candidate | undefined;
  }> {
    const textParts: string[] = [];
    let usage: GenerateContentResponseUsageMetadata | undefined;
    let lastCandidate: Candidate | undefined;

    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: userPrompt,
      config,
    });

    for await (const chunk of stream) {
      if (chunk.usageMetadata !== undefined) {
        usage = chunk.usageMetadata;
      }

      const candidate = chunk.candidates?.[0];
      if (candidate === undefined) {
        continue;
      }
      lastCandidate = candidate;

      for (const part of candidate.content?.parts ?? []) {
        const partText = part.text ?? "";
        if (part.thought === true) {
          forwardThought(onThought, agent, partText);
        } else if (partText.length > 0) {
          textParts.push(partText);
        }
      }
    }

    return { text: textParts.join(""), usage, candidate: lastCandidate };
  }
}

/** Map tool names to SDK `Tool` objects. Unknown names are ignored. */
function buildTools(tools: string[]): Tool[] {
  const configTools: Tool[] = [];
  if (tools.includes("googleSearch")) {
    configTools.push({ googleSearch: {} });
  }
  if (tools.includes("urlContext")) {
    configTools.push({ urlContext: {} });
  }
  return configTools;
}

/**
 * Forward a thought chunk, swallowing any error the callback throws: a broken
 * SSE pipe must not abort the generation call.
 */
function forwardThought(
  onThought: NonNullable<GenerateOptions["onThought"]>,
  agent: string,
  chunk: string,
): void {
  if (chunk.length === 0) {
    return;
  }
  try {
    onThought(agent, chunk);
  } catch {
    // Intentionally ignored — a broken consumer must not abort generation.
  }
}

function extractGroundingChunks(
  candidate: Candidate | undefined,
): Record<string, unknown>[] | null {
  const grounding = candidate?.groundingMetadata;
  if (grounding === undefined) {
    return null;
  }
  return (grounding.groundingChunks ?? []) as Record<string, unknown>[];
}
