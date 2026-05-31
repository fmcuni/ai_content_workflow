/**
 * Topic-dedup agent — TypeScript port of `content_tool/agents/topic_dedup.py`.
 *
 * One Gemini call per candidate: looks up `site:bowtie.com.hk/blog` to decide
 * whether the input topic is already covered. No retry/backoff and no DB writes
 * — those are the TopicExpansionWorkflow's concern (assembled by the lead). This
 * function returns the parsed verdict plus token usage.
 *
 * Full-width punctuation (：、（無）) is intentional — the prompts are CJK style,
 * matching the Python `build_user_prompt` byte-for-byte.
 */

import type { Sql } from "postgres";
import { getAssembled } from "../prompts/store";
import type { GeminiClient, ThoughtCallback } from "../gemini/types";
import { TOPIC_DEDUP_SCHEMA, type TopicDedupOutput } from "./topic_schemas";

// ---------------------------------------------------------------------------
// Input — mirrors Python TopicDedupInput.
// ---------------------------------------------------------------------------

export interface TopicDedupInput {
  topic: string;
  keywords: string[];
  onThought?: ThoughtCallback;
}

// ---------------------------------------------------------------------------
// Token usage result (mirrors OutlineTokens)
// ---------------------------------------------------------------------------

export interface TopicDedupTokens {
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// System prompt assembly — mirrors Python `build_system_prompt`.
// ---------------------------------------------------------------------------

async function buildSystemPrompt(sql: Sql): Promise<string> {
  return getAssembled(sql, "topic_dedup");
}

// ---------------------------------------------------------------------------
// User prompt — mirrors Python `build_user_prompt` exactly.
// ---------------------------------------------------------------------------

export function buildUserPrompt(opts: { topic: string; keywords: string[] }): string {
  const keywords = opts.keywords.length > 0 ? opts.keywords.join(", ") : "（無）";
  return (
    "請判斷以下單一 topic 在 site:bowtie.com.hk/blog 是否已有相同 topic 的文章。" +
    "只輸出符合 schema 的 JSON。\n\n" +
    `topic:\n${opts.topic}\n\n` +
    `focus_keywords:\n${keywords}\n`
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the topic-dedup agent for one candidate. Assembles the system + user
 * prompt, calls Gemini with structured output and the googleSearch + urlContext
 * grounding tools, and returns the parsed verdict plus token usage. No DB writes.
 */
export async function runTopicDedup(
  sql: Sql,
  gemini: GeminiClient,
  input: TopicDedupInput,
): Promise<{ output: TopicDedupOutput; tokens: TopicDedupTokens }> {
  const systemPrompt = await buildSystemPrompt(sql);
  const userPrompt = buildUserPrompt({ topic: input.topic, keywords: input.keywords });

  const result = await gemini.generate({
    agent: "topic_dedup",
    systemPrompt,
    userPrompt,
    responseSchema: TOPIC_DEDUP_SCHEMA as Record<string, unknown>,
    tools: ["googleSearch", "urlContext"],
    onThought: input.onThought,
  });

  // Gemini returns a plain object matching TopicDedupOutput's shape when
  // responseSchema is provided. Route through `unknown` since
  // `GeminiResult.parsed` is `Record<string, unknown>`.
  const output = result.parsed as unknown as TopicDedupOutput;

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
