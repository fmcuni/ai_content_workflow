/**
 * GeminiProxy — a US-pinned Durable Object that performs the actual Gemini call.
 *
 * The normal Worker colo (Asia/HK) is geo-blocked by Google AI Studio
 * ("400 User location is not supported"). A Durable Object obtained via
 * `get(id, { locationHint: "enam" })` runs in a US data center, so its egress IP
 * is US-based and Google allows the request. `DoGeminiClient` forwards every
 * `generate()` here, so ALL pipeline Gemini calls (outline / writer / audit /
 * gap / topic / evals) originate from a supported location through one lever.
 *
 * Streaming (`onThought`) is intentionally NOT carried across the RPC boundary:
 * functions are not structured-cloneable. Live thought SSE is deferred; the
 * non-streaming path produces byte-identical parsed output. The DO itself holds
 * no persistent state — it is purely a regional execution shim.
 */

import { DurableObject } from "cloudflare:workers";

import type { Env } from "../index";
import { RealGeminiClient } from "./client";
import type { GeminiResult, GenerateOptions } from "./types";

const DEFAULT_MODEL = "gemini-3.1-pro-preview";

/** GenerateOptions minus the non-cloneable `onThought` callback. */
export type ProxyGenerateOptions = Omit<GenerateOptions, "onThought">;

/** RPC request envelope for {@link GeminiProxy.generate}. */
export interface ProxyGenerateRequest {
  model: string;
  thinkingLevel: string;
  opts: ProxyGenerateOptions;
}

export class GeminiProxy extends DurableObject<Env> {
  /**
   * Run a single non-streaming Gemini generation from the DO's US region. The
   * API key stays in the DO's own `env` (never crosses the RPC boundary); the
   * caller supplies only the model + thinking level so they remain overridable.
   */
  async generate(req: ProxyGenerateRequest): Promise<GeminiResult> {
    const client = new RealGeminiClient({
      apiKey: this.env.GEMINI_API_KEY,
      model: req.model || (this.env.GEMINI_MODEL ?? DEFAULT_MODEL),
      thinkingLevel: req.thinkingLevel,
    });
    return client.generate(req.opts);
  }
}
