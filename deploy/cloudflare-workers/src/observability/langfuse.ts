/**
 * Langfuse observability — gated, fetch-based, edge-safe.
 *
 * The TypeScript mirror of the Python `content_tool/observability/langfuse_client.py`
 * + `content_tool/gemini/observed.py`. Every Gemini `generate()` call in the
 * production Workers backend can emit a Langfuse GENERATION, grouped by `run_id`
 * (used as the trace id), so a run's outline / writer / audit / gap / topic /
 * judge generations all hang off one trace — matching the Python side.
 *
 * Hard guardrails (do not relax):
 *   - Flag defaults OFF. When `LANGFUSE_ENABLED` is unset / falsey, or either key
 *     is absent, this module is a STRICT no-op: no client is constructed, no
 *     network call is made, and the `langfuse` package is never imported.
 *   - Prompts flow ONE-WAY into traces (as generation `input`). Langfuse Prompt
 *     Management is NEVER used — we never read prompts from or store prompts in
 *     Langfuse.
 *   - Langfuse failures NEVER propagate. Every public helper swallows + logs so a
 *     tracing fault cannot break a run. This is ADDITIVE observability only.
 *
 * Edge flush: the classic `langfuse` SDK is fetch-based and supported on
 * Cloudflare Workers. Events are queued and must be flushed within the
 * request/DO lifecycle via {@link flushLangfuse} — call it from
 * `ctx.waitUntil(flushLangfuse(client))` (or `await` it before a DO RPC returns)
 * so queued spans are delivered before the isolate is frozen.
 */

import type { Langfuse } from "langfuse";

/** Env fields this module reads. Mirrors the Python `Settings.langfuse_*`. */
export interface LangfuseEnv {
  /** "true"/"1"/"on"/"yes" enables; anything else (or unset) = OFF. */
  LANGFUSE_ENABLED?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  /** Langfuse host, e.g. "https://cloud.langfuse.com". */
  LANGFUSE_HOST?: string;
}

/** Prompt-template identity for one generation. Mirrors Python `PromptMeta`. */
export interface PromptMeta {
  templateId?: string;
  voiceSlug?: string;
  sha256?: string;
}

/** Inputs for a single generation record. */
export interface GenerationRecord {
  /** Generation name — the agent, e.g. "writer", "outline", "judge.brand_voice". */
  agent: string;
  systemPrompt: string;
  userPrompt: string;
  rawText: string;
  parsed: Record<string, unknown>;
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
  finishReason: string | null;
  /** Groups all generations of one run under a single Langfuse trace. */
  runId?: string;
  promptMeta?: PromptMeta;
}

const ENABLED_TOKENS = new Set(["true", "1", "on", "yes"]);

/**
 * True when the flag is explicitly on AND both keys are present. Cheap, pure,
 * no imports — callers gate on this before doing any Langfuse work.
 */
export function isLangfuseEnabled(env: LangfuseEnv): boolean {
  const flag = (env.LANGFUSE_ENABLED ?? "").trim().toLowerCase();
  if (!ENABLED_TOKENS.has(flag)) {
    return false;
  }
  return Boolean(env.LANGFUSE_PUBLIC_KEY) && Boolean(env.LANGFUSE_SECRET_KEY);
}

/**
 * Construct a Langfuse client, or `null` when disabled / misconfigured / the
 * package import fails. NEVER throws — a tracing-setup fault must not break a run.
 * The `langfuse` package is imported lazily so a disabled backend never loads it.
 */
export async function getLangfuse(env: LangfuseEnv): Promise<Langfuse | null> {
  if (!isLangfuseEnabled(env)) {
    return null;
  }
  try {
    const { Langfuse } = await import("langfuse");
    return new Langfuse({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_HOST,
    });
  } catch (err: unknown) {
    console.warn(`langfuse: client init failed, observability disabled — ${describe(err)}`);
    return null;
  }
}

/**
 * Emit one GENERATION on `client`. Mirrors `ObservedGeminiClient._record`:
 *   - name          : the agent
 *   - input         : { systemPrompt, userPrompt }  (one-way; no Prompt Mgmt)
 *   - output        : { rawText, parsed }
 *   - usageDetails  : { input, output, total }       (total includes thinking)
 *   - metadata      : { latencyMs, finishReason, templateId, voiceSlug, prompt sha, runId }
 *   - traceId       : runId — groups a run's generations under one trace
 *
 * Returns nothing and NEVER throws — failures are swallowed + logged. Events are
 * only queued here; the caller flushes within the request/DO lifecycle.
 */
export function emitGeneration(client: Langfuse, record: GenerationRecord): void {
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - Math.max(record.latencyMs, 0));

    const metadata: Record<string, unknown> = {
      latencyMs: record.latencyMs,
      finishReason: record.finishReason,
    };
    if (record.promptMeta?.templateId !== undefined) {
      metadata.templateId = record.promptMeta.templateId;
    }
    if (record.promptMeta?.voiceSlug !== undefined) {
      metadata.voiceSlug = record.promptMeta.voiceSlug;
    }
    if (record.promptMeta?.sha256 !== undefined) {
      metadata.promptSha256 = record.promptMeta.sha256;
    }
    if (record.runId !== undefined) {
      metadata.runId = record.runId;
    }

    const generation = client.generation({
      name: record.agent,
      // runId as traceId groups all of a run's generations under one trace.
      ...(record.runId !== undefined ? { traceId: record.runId } : {}),
      input: { systemPrompt: record.systemPrompt, userPrompt: record.userPrompt },
      output: { rawText: record.rawText, parsed: record.parsed },
      usageDetails: {
        input: record.tokensIn,
        output: record.tokensOut,
        total: record.tokensIn + record.tokensOut + record.thinkingTokens,
      },
      metadata,
      startTime,
      endTime,
    });
    generation.end();
  } catch (err: unknown) {
    console.warn(`langfuse: generation record failed (swallowed) — ${describe(err)}`);
  }
}

/**
 * Flush queued events. No-op on `null`. NEVER throws. Call inside the
 * request/DO lifecycle — e.g. `ctx.waitUntil(flushLangfuse(client))` — so the
 * fetch-based exporter delivers before the isolate is frozen.
 */
export async function flushLangfuse(client: Langfuse | null): Promise<void> {
  if (client === null) {
    return;
  }
  try {
    await client.flushAsync();
  } catch (err: unknown) {
    console.warn(`langfuse: flush failed, some traces may be lost — ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
