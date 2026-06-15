/**
 * Topic hot-topic agent — TypeScript port of `content_tool/agents/topic_hot.py`.
 *
 * One Gemini call per candidate: inspects the HK SERP for the topic and decides
 * whether it qualifies as a "hot topic." No retry/backoff and no DB writes —
 * those are the TopicExpansionWorkflow's concern (assembled by the lead). This
 * function returns the parsed verdict plus token usage.
 *
 * Full-width punctuation (：、（無）) is intentional — the prompts are CJK style,
 * matching the Python `build_user_prompt` byte-for-byte.
 */

import type { Sql } from "postgres";
import { getAssembled } from "../prompts/store";
import { loadPersona } from "./persona";
import type { GeminiClient, ThoughtCallback } from "../gemini/types";
import { TOPIC_HOT_SCHEMA, type TopicHotOutput } from "./topic_schemas";

// ---------------------------------------------------------------------------
// Input — mirrors Python TopicHotInput.
// ---------------------------------------------------------------------------

export interface TopicHotInput {
  topic: string;
  keywords: string[];
  /** The batch/candidate voice (persona slug); resolves the prompt under it. */
  voiceSlug: string;
  onThought?: ThoughtCallback;
}

// ---------------------------------------------------------------------------
// Token usage result (mirrors OutlineTokens)
// ---------------------------------------------------------------------------

export interface TopicHotTokens {
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// System prompt assembly — mirrors Python `build_system_prompt`.
// ---------------------------------------------------------------------------

async function buildSystemPrompt(sql: Sql, voiceSlug: string): Promise<string> {
  return getAssembled(sql, "topic_hot", voiceSlug);
}

// ---------------------------------------------------------------------------
// User prompt — mirrors Python `build_user_prompt` exactly.
// ---------------------------------------------------------------------------

export function buildUserPrompt(opts: {
  topic: string;
  keywords: string[];
  /** The voice's market (VoiceLocale.market); defaults to HK-ZH "Google 香港繁中". */
  market?: string;
}): string {
  const keywords = opts.keywords.length > 0 ? opts.keywords.join(", ") : "（無）";
  const market = opts.market ?? "Google 香港繁中";
  return (
    `請分析以下單一 topic 在 ${market} SERP 是否屬於熱門話題。` +
    "只輸出符合 schema 的 JSON。\n\n" +
    `topic:\n${opts.topic}\n\n` +
    `focus_keywords:\n${keywords}\n`
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the topic-hot agent for one candidate. Assembles the system + user prompt,
 * calls Gemini with structured output and the googleSearch + urlContext
 * grounding tools, and returns the parsed verdict plus token usage. No DB writes.
 */
export async function runTopicHot(
  sql: Sql,
  gemini: GeminiClient,
  input: TopicHotInput,
): Promise<{ output: TopicHotOutput; tokens: TopicHotTokens }> {
  const systemPrompt = await buildSystemPrompt(sql, input.voiceSlug);
  // Resolve the voice's market locally (spec §4.4 item 7) so a non-HK voice asks
  // about ITS market. HK-ZH default keeps "Google 香港繁中" → byte-identical.
  const { locale } = await loadPersona(sql, input.voiceSlug);
  const userPrompt = buildUserPrompt({
    topic: input.topic,
    keywords: input.keywords,
    market: locale.market,
  });

  const result = await gemini.generate({
    agent: "topic_hot",
    systemPrompt,
    userPrompt,
    responseSchema: TOPIC_HOT_SCHEMA as Record<string, unknown>,
    tools: ["googleSearch", "urlContext"],
    onThought: input.onThought,
  });

  // Gemini returns a plain object matching TopicHotOutput's shape when
  // responseSchema is provided. Route through `unknown` since
  // `GeminiResult.parsed` is `Record<string, unknown>`.
  const output = result.parsed as unknown as TopicHotOutput;

  return {
    output,
    tokens: {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      thinkingTokens: result.thinkingTokens,
      latencyMs: result.latencyMs,
    },
  };
}
