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
  /**
   * Separates traces by origin in the Langfuse UI (e.g. "production" vs
   * "development"). Must be a lowercase alphanumeric string with hyphens/
   * underscores that does not start with "langfuse". Defaults to "production"
   * for the deployed Worker when unset. Mirrors Python `langfuse_environment`.
   */
  LANGFUSE_TRACING_ENVIRONMENT?: string;
}

/** Prompt-template identity for one generation. Mirrors Python `PromptMeta`. */
export interface PromptMeta {
  templateId?: string;
  voiceSlug?: string;
  sha256?: string;
}

/** Run-level identity used to name + tag the run's Langfuse trace. */
export interface TraceMeta {
  /** The run's topic / article subject — becomes the trace name. */
  topic?: string;
  /** Entry mode (e.g. "refresh", "create") — becomes a trace tag. */
  startMode?: string;
}

/** Inputs for a single generation record. */
export interface GenerationRecord {
  /** Generation name — the agent, e.g. "writer", "outline", "judge.brand_voice". */
  agent: string;
  /** Gemini model name — lets Langfuse run model analytics + auto cost calc. */
  model: string;
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
  /** Run-level info to name + tag the trace (topic, entry mode). */
  traceMeta?: TraceMeta;
}

const ENABLED_TOKENS = new Set(["true", "1", "on", "yes"]);

/**
 * Hard cap on how long {@link flushLangfuse} waits for delivery. A try/catch
 * cannot rescue a *hang* — a host that accepts the connection but never responds
 * (an unreachable tunnel, a Langfuse outage). Since the flush runs inside the
 * DO's `ctx.waitUntil`, an unbounded await holds the invocation open until the
 * wall-clock limit, which surfaces as a thrown exception that breaks the run.
 * Bounding it keeps tracing strictly additive: worst case we drop traces, never
 * a run. Generous enough for a healthy Cloud flush (sub-second), well under the
 * DO wall-clock budget.
 */
const FLUSH_TIMEOUT_MS = 8_000;

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
    const client = new Langfuse({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_HOST,
      // Default the deployed Worker to "production"; override via the env var.
      environment: env.LANGFUSE_TRACING_ENVIRONMENT || "production",
    });
    return client;
  } catch (err: unknown) {
    console.warn(`langfuse: client init failed, observability disabled — ${describe(err)}`);
    return null;
  }
}

/**
 * Emit one GENERATION on `client`. Mirrors `ObservedGeminiClient._record`:
 *   - name          : the agent
 *   - model         : Gemini model name (drives model analytics + auto cost calc)
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
    // Upsert the trace (keyed on runId) so the run appears in the Traces view
    // with its generations nested under it. The classic SDK otherwise emits only
    // the observation, and on Langfuse's observations-first projects a generation
    // carrying a foreign traceId lands as an observation but never materializes a
    // trace row — leaving the Traces view empty. trace() is idempotent (an upsert
    // on `id`), so every generation of a run safely re-asserts the same trace.
    if (record.runId !== undefined) {
      const topic = record.traceMeta?.topic?.trim();
      const startMode = record.traceMeta?.startMode?.trim();
      const shortId = record.runId.slice(0, 8);
      // e.g. "兒童手足口病 · 6ba2801c" — topic + short run id; falls back to the id.
      const traceName = topic ? `${topic} · ${shortId}` : `run · ${shortId}`;
      const tags = [startMode, record.promptMeta?.voiceSlug].filter(
        (t): t is string => Boolean(t),
      );
      client.trace({
        id: record.runId,
        name: traceName,
        ...(tags.length > 0 ? { tags } : {}),
        metadata: {
          runId: record.runId,
          ...(topic !== undefined ? { topic } : {}),
          ...(startMode !== undefined ? { startMode } : {}),
        },
      });
    }

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
      model: record.model,
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
    // shutdownAsync flushes AND awaits all in-flight ingestion requests — unlike
    // flushAsync, which can resolve before the HTTP completes, letting a
    // short-lived Worker/DO isolate freeze and drop the send.
    //
    // Raced against a timeout because the catch below only handles a *rejection*,
    // not a *hang*: an unreachable/slow host can leave shutdownAsync pending
    // forever, holding the DO's waitUntil open until the wall-clock limit throws
    // and breaks the run. The timeout converts that into a swallowed "traces
    // lost" log.
    await withTimeout(client.shutdownAsync(), FLUSH_TIMEOUT_MS);
  } catch (err: unknown) {
    console.warn(`langfuse: flush failed, some traces may be lost — ${describe(err)}`);
  }
}

/**
 * Resolve `promise`, or reject after `ms` if it has not settled. The pending
 * `promise` is left to settle on its own (we cannot cancel an in-flight fetch);
 * the timer is always cleared so it never leaks.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`flush timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
