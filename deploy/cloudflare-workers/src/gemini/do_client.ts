/**
 * DoGeminiClient — a `GeminiClient` that forwards generation to the US-pinned
 * {@link GeminiProxy} Durable Object, working around the Asia/HK geo-block on
 * Google AI Studio. Same interface as {@link RealGeminiClient}, so swapping it
 * into ProductionWorkflow is a one-line construction change.
 *
 * The `onThought` streaming callback is dropped here because functions cannot
 * cross the DO RPC boundary; the proxy runs the non-streaming path, which yields
 * identical parsed output. Live thought SSE is deferred to a later phase.
 */

import type { GeminiClient, GeminiResult, GenerateOptions } from "./types";
import type { GeminiProxy, ProxyGenerateOptions } from "./proxy_do";

/** Minimal config DoGeminiClient passes through to the proxy (apiKey stays in the DO env). */
export interface DoGeminiClientConfig {
  model: string;
  thinkingLevel: string;
}

/** Default US region hint — probe-confirmed to bypass the geo-block (enam/wnam both work). */
const DEFAULT_LOCATION_HINT: DurableObjectLocationHint = "enam";

export class DoGeminiClient implements GeminiClient {
  constructor(
    private readonly namespace: DurableObjectNamespace<GeminiProxy>,
    private readonly config: DoGeminiClientConfig,
    private readonly locationHint: DurableObjectLocationHint = DEFAULT_LOCATION_HINT,
  ) {}

  async generate(opts: GenerateOptions): Promise<GeminiResult> {
    // Strip the non-cloneable onThought callback by re-constructing the opts
    // explicitly (immutable; avoids leaking the function across the RPC edge).
    const proxyOpts: ProxyGenerateOptions = {
      agent: opts.agent,
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      responseSchema: opts.responseSchema,
      tools: opts.tools,
    };

    const id = this.namespace.idFromName(`gemini-proxy-${this.locationHint}`);
    const stub = this.namespace.get(id, { locationHint: this.locationHint });
    return stub.generate({
      model: this.config.model,
      thinkingLevel: this.config.thinkingLevel,
      opts: proxyOpts,
    });
  }
}
