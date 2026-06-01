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
 * Live thought streaming: the `onThought` callback cannot cross the RPC boundary
 * (functions are not structured-cloneable), so the caller instead passes a
 * `runId`. When present, the proxy reconstructs the callback HERE inside the DO
 * and POSTs each thought chunk straight to that run's RUN_STREAM hub as a
 * `{agent}.thinking` event — mirroring RunExecutor._emit_thought in the Python
 * backend. POSTs are serialized so chunks arrive in order (the frontend
 * concatenates them). When no `runId` is supplied (e.g. refresh / topic scans
 * with no live viewer) the non-streaming path runs and no thoughts are emitted.
 */

import { DurableObject } from "cloudflare:workers";

import type { Env } from "../index";
import { RealGeminiClient } from "./client";
import type { GeminiResult, GenerateOptions, ThoughtCallback } from "./types";

const DEFAULT_MODEL = "gemini-3.1-pro-preview";

/** GenerateOptions minus the non-cloneable `onThought` callback. */
export type ProxyGenerateOptions = Omit<GenerateOptions, "onThought">;

/** RPC request envelope for {@link GeminiProxy.generate}. */
export interface ProxyGenerateRequest {
  model: string;
  thinkingLevel: string;
  opts: ProxyGenerateOptions;
  /**
   * When set, the proxy streams thought parts live to this run's RUN_STREAM hub
   * instead of running the silent non-streaming path. The SSE callback is built
   * inside the DO (functions can't cross the RPC edge).
   */
  runId?: string;
}

export class GeminiProxy extends DurableObject<Env> {
  /**
   * Run a single Gemini generation from the DO's US region. The API key stays in
   * the DO's own `env` (never crosses the RPC boundary); the caller supplies only
   * the model + thinking level so they remain overridable. When `req.runId` is
   * set, thought parts stream live to that run's SSE hub.
   */
  async generate(req: ProxyGenerateRequest): Promise<GeminiResult> {
    const client = new RealGeminiClient({
      apiKey: this.env.GEMINI_API_KEY,
      model: req.model || (this.env.GEMINI_MODEL ?? DEFAULT_MODEL),
      thinkingLevel: req.thinkingLevel,
    });

    const { runId } = req;
    if (runId === undefined) {
      return client.generate(req.opts);
    }

    // Serialize thought POSTs onto a promise chain so chunks reach RUN_STREAM in
    // order (the frontend concatenates contiguous chunks per agent). A failed
    // POST is swallowed — a broken SSE pipe must never abort generation.
    let chain: Promise<void> = Promise.resolve();
    const onThought: ThoughtCallback = (agent, chunk) => {
      chain = chain.then(() => this.appendThought(runId, agent, chunk));
    };

    const result = await client.generate({ ...req.opts, onThought });
    // Ensure every queued thought lands before the step's await resolves.
    await chain;
    return result;
  }

  /** POST one `{agent}.thinking` event to the run's RUN_STREAM hub. */
  private async appendThought(runId: string, agent: string, chunk: string): Promise<void> {
    const envelope = {
      event: `${agent}.thinking`,
      run_id: runId,
      // Mirrors production.ts isoZ() / Python datetime.utcnow().isoformat()+"Z".
      timestamp: new Date().toISOString(),
      payload: { agent, chunk },
    };
    try {
      await this.env.RUN_STREAM.get(this.env.RUN_STREAM.idFromName(runId)).fetch(
        "https://run-stream/append",
        { method: "POST", body: JSON.stringify(envelope) },
      );
    } catch {
      // Intentionally ignored — a dropped subscriber must not abort generation.
    }
  }
}
