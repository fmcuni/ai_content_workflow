/**
 * DoGeminiClient — a `GeminiClient` that forwards generation to the US-pinned
 * {@link GeminiProxy} Durable Object, working around the Asia/HK geo-block on
 * Google AI Studio. Same interface as {@link RealGeminiClient}, so swapping it
 * into ProductionWorkflow is a one-line construction change.
 *
 * The `onThought` streaming callback cannot cross the DO RPC boundary (functions
 * are not structured-cloneable), so instead we forward the run's `runId`. When
 * present, the proxy rebuilds the callback on its side and streams thought chunks
 * straight to that run's RUN_STREAM hub — restoring live "model thinking" SSE in
 * production (the Python backend gets this via an in-process emitter). Callers
 * with no live viewer (refresh / topic scans) omit `runId` and stay non-streaming.
 */

import type { PromptMeta, TraceMeta } from "../observability/langfuse";
import type { GeminiClient, GeminiResult, GenerateOptions } from "./types";
import type { GeminiProxy, ProxyGenerateOptions } from "./proxy_do";

/** Minimal config DoGeminiClient passes through to the proxy (apiKey stays in the DO env). */
export interface DoGeminiClientConfig {
  model: string;
  thinkingLevel: string;
  /** When set, the proxy streams live thought chunks to this run's SSE hub. */
  runId?: string;
  /**
   * Optional prompt-template identity, forwarded one-way into Langfuse generation
   * metadata (voice slug / template id / sha256). Omit when not available —
   * observability degrades gracefully without it.
   */
  promptMeta?: PromptMeta;
  /** Run-level info (topic, entry mode) to name + tag the run's Langfuse trace. */
  traceMeta?: TraceMeta;
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
    // The proxy re-derives streaming from `runId` instead — see proxy_do.ts.
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
      runId: this.config.runId,
      promptMeta: this.config.promptMeta,
      traceMeta: this.config.traceMeta,
    });
  }
}
