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

    let text: string;
    let usage: GenerateContentResponseUsageMetadata | undefined;
    let candidate: Candidate | undefined;

    if (onThought !== undefined) {
      const streamed = await this.streamCall(agent, userPrompt, config, onThought);
      text = streamed.text;
      usage = streamed.usage;
      candidate = streamed.candidate;
    } else {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: userPrompt,
        config,
      });
      text = response.text ?? "";
      usage = response.usageMetadata;
      candidate = response.candidates?.[0];
    }

    const latencyMs = Date.now() - startedAt;

    // Only parse JSON when the caller actually requested structured output.
    // A null schema means a plain-text reply is expected (e.g. the setup
    // credential check), so forcing JSON parsing there would reject a valid
    // response (commit 563c524). `parsed` stays `{}` in that case.
    const parsed = responseSchema !== null ? parseGeminiJson(text) : {};

    return {
      parsed,
      rawText: text,
      tokensIn: usage?.promptTokenCount ?? 0,
      tokensOut: usage?.candidatesTokenCount ?? 0,
      thinkingTokens: usage?.thoughtsTokenCount ?? 0,
      latencyMs,
      groundingChunks: extractGroundingChunks(candidate),
      finishReason: candidate?.finishReason ?? null,
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
