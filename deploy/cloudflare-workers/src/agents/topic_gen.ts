/**
 * Topic-generation agent — TypeScript port of `content_tool/agents/topic_gen.py`.
 *
 * One Gemini call: take a research brief and produce a list of pillar-topic
 * candidates with focus keywords. No DB writes — the caller (the
 * TopicExpansionWorkflow, assembled by the lead) persists the rows; this
 * function returns the parsed candidates plus token usage.
 *
 * Full-width punctuation (：、（無）) is intentional — the prompts are CJK style,
 * matching the Python `build_user_prompt` byte-for-byte.
 */

import type { Sql } from "postgres";
import { getAssembled } from "../prompts/store";
import type { GeminiClient, ThoughtCallback } from "../gemini/types";
import { TOPIC_GEN_SCHEMA, type TopicGenOutput } from "./topic_schemas";

// ---------------------------------------------------------------------------
// Input — mirrors Python TopicGenInput (content_tool/models/topic_batch.py)
// ---------------------------------------------------------------------------

export interface TopicGenInput {
  researchTheme: string;
  targetAudience: string;
  topicCount: number;
  keywordsPerTopic: number;
  mustCover: string[];
  mustAvoid: string[];
  priorityFocus?: string | null;
  notes?: string | null;
  /** The batch's voice (persona slug); resolves the prompt under it. */
  voiceSlug: string;
  onThought?: ThoughtCallback;
}

// ---------------------------------------------------------------------------
// Token usage result (mirrors OutlineTokens)
// ---------------------------------------------------------------------------

export interface TopicGenTokens {
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// System prompt assembly — mirrors Python `build_system_prompt`.
// ---------------------------------------------------------------------------

async function buildSystemPrompt(sql: Sql, voiceSlug: string): Promise<string> {
  return getAssembled(sql, "topic_gen", voiceSlug);
}

// ---------------------------------------------------------------------------
// List block — mirrors Python `_format_list_block`.
// ---------------------------------------------------------------------------

function formatListBlock(items: string[]): string {
  if (items.length === 0) {
    return "（無）";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

// ---------------------------------------------------------------------------
// User prompt — mirrors Python `build_user_prompt` exactly.
// ---------------------------------------------------------------------------

export function buildUserPrompt(opts: {
  researchTheme: string;
  targetAudience: string;
  topicCount: number;
  keywordsPerTopic: number;
  mustCover: string[];
  mustAvoid: string[];
  priorityFocus?: string | null;
  notes?: string | null;
}): string {
  return (
    "請根據以下研究設定產出結果。\n\n" +
    `研究主題：${opts.researchTheme}\n` +
    `目標受眾：${opts.targetAudience}\n` +
    `主題數量：${opts.topicCount}\n` +
    `每個主題關鍵字數量：${opts.keywordsPerTopic}\n\n` +
    `必須涵蓋範疇：\n${formatListBlock(opts.mustCover)}\n\n` +
    `避免主題：\n${formatListBlock(opts.mustAvoid)}\n\n` +
    `額外偏重方向：\n${opts.priorityFocus || "（無）"}\n\n` +
    `補充要求：\n${opts.notes || "（無）"}\n`
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the topic-gen agent. Assembles the system + user prompt, calls Gemini with
 * structured output and the googleSearch + urlContext grounding tools, and
 * returns the parsed candidates plus token usage. No DB writes.
 */
export async function runTopicGen(
  sql: Sql,
  gemini: GeminiClient,
  input: TopicGenInput,
): Promise<{ output: TopicGenOutput; tokens: TopicGenTokens }> {
  const systemPrompt = await buildSystemPrompt(sql, input.voiceSlug);
  const userPrompt = buildUserPrompt({
    researchTheme: input.researchTheme,
    targetAudience: input.targetAudience,
    topicCount: input.topicCount,
    keywordsPerTopic: input.keywordsPerTopic,
    mustCover: input.mustCover,
    mustAvoid: input.mustAvoid,
    priorityFocus: input.priorityFocus,
    notes: input.notes,
  });

  const result = await gemini.generate({
    agent: "topic_gen",
    systemPrompt,
    userPrompt,
    responseSchema: TOPIC_GEN_SCHEMA as Record<string, unknown>,
    tools: ["googleSearch", "urlContext"],
    onThought: input.onThought,
  });

  // Gemini returns a plain object matching TopicGenOutput's shape when
  // responseSchema is provided. Route through `unknown` since
  // `GeminiResult.parsed` is `Record<string, unknown>`.
  const output = result.parsed as unknown as TopicGenOutput;

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
