/**
 * Shared types for the Gemini client wrapper.
 *
 * Ported from `content_tool/gemini/client.py` (Python). The TS `@google/genai`
 * SDK uses camelCase config keys (e.g. `responseMimeType`, `responseJsonSchema`,
 * `thinkingConfig`) and camelCase usageMetadata fields (`promptTokenCount`,
 * `candidatesTokenCount`, `thoughtsTokenCount`).
 */

/** Forwards a streamed thought chunk for a given agent (SSE pipe). */
export type ThoughtCallback = (agent: string, chunk: string) => void;

/** Options for a single `generate` call. */
export interface GenerateOptions {
  agent: string;
  systemPrompt: string;
  userPrompt: string;
  /** JSON schema for structured output, or `null` for a plain-text reply. */
  responseSchema: Record<string, unknown> | null;
  /** Tool names to enable, e.g. `"googleSearch"`, `"urlContext"`. */
  tools: string[];
  /** When provided, the call streams and forwards thought parts here. */
  onThought?: ThoughtCallback;
}

/** Normalized result of a Gemini generation. */
export interface GeminiResult {
  parsed: Record<string, unknown>;
  rawText: string;
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
  groundingChunks: Record<string, unknown>[] | null;
  finishReason: string | null;
}

/** Common interface implemented by the real and fake clients. */
export interface GeminiClient {
  generate(opts: GenerateOptions): Promise<GeminiResult>;
}
