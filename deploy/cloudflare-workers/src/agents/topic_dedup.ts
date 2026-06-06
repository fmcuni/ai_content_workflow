/**
 * Topic-dedup agent (two-stage) — TypeScript port of
 * `content_tool/agents/topic_dedup.py`.
 *
 * Stage 1 (`runExistingArticleSearch`) runs a *grounded* search and returns the
 * REAL `bowtie.com.hk/blog` article URLs from Gemini's grounding metadata.
 * Stage 2 (here) is the verdict call: the judge picks `existing_url` strictly
 * from that real candidate list, so the field can only ever be a verifiable URL
 * or the empty string — never a hallucination. No retry/backoff and no DB
 * writes; those are the TopicExpansionWorkflow's concern.
 *
 * Full-width punctuation (：、（無）) is intentional — the prompts are CJK style,
 * matching the Python `build_user_prompt` byte-for-byte.
 */

import type { Sql } from "postgres";
import { getAssembled } from "../prompts/store";
import type { GeminiClient, ThoughtCallback } from "../gemini/types";
import {
  type ExistingArticle,
  type Stage1Diagnostics,
  type UrlResolveFn,
  runExistingArticleSearch,
} from "./topic_existing_search";
import { resolveUrl } from "./url_resolver";
import { TOPIC_DEDUP_SCHEMA, type TopicDedupOutput } from "./topic_schemas";

// Appended to `existing_note` when stage-1 could not confirm the candidate list
// because resolves failed (so a real article may have been missed). Kept
// byte-identical to the Python `_DEGRADED_NOTE_SUFFIX`.
const DEGRADED_NOTE_SUFFIX =
  "（系統提示：檢索時連結解析失敗，未能確認是否已有文章，請人手覆檢。）";

export interface TopicDedupInput {
  topic: string;
  keywords: string[];
  /** The batch/candidate voice (persona slug); resolves both stages' prompts. */
  voiceSlug: string;
  onThought?: ThoughtCallback;
}

export interface TopicDedupTokens {
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
}

async function buildSystemPrompt(sql: Sql, voiceSlug: string): Promise<string> {
  return getAssembled(sql, "topic_dedup", voiceSlug);
}

function renderCandidates(candidates: ExistingArticle[]): string {
  if (candidates.length === 0) {
    return "候選文章：（無，搜尋不到相關文章）";
  }
  const lines = ["候選文章（系統預先搜尋找到的真實 URL，existing_url 只可從這裡照抄其一）："];
  candidates.forEach((art, i) => {
    const title = art.title ?? "（無標題）";
    lines.push(`${i + 1}. ${title} — ${art.url}`);
  });
  return lines.join("\n");
}

export function buildUserPrompt(
  opts: { topic: string; keywords: string[] },
  candidates: ExistingArticle[],
): string {
  const keywords = opts.keywords.length > 0 ? opts.keywords.join(", ") : "（無）";
  return (
    "請判斷以下單一 topic 在 site:bowtie.com.hk/blog 是否已有相同 topic 的文章。" +
    "只輸出符合 schema 的 JSON。\n\n" +
    `topic:\n${opts.topic}\n\n` +
    `focus_keywords:\n${keywords}\n\n` +
    `${renderCandidates(candidates)}\n`
  );
}

/**
 * Force `existing_url` to be one of the real candidate URLs, else blank.
 * Defence-in-depth against the judge fabricating a URL despite the prompt. If
 * blanking would leave a `yes` verdict with no source, downgrade to `not_sure`.
 */
function constrainToCandidates(
  output: TopicDedupOutput,
  candidates: ExistingArticle[],
): TopicDedupOutput {
  const byKey = new Map<string, string>();
  for (const art of candidates) byKey.set(art.url.replace(/\/+$/, ""), art.url);
  const matched = byKey.get((output.existing_url ?? "").replace(/\/+$/, ""));
  if (matched !== undefined) {
    return { ...output, existing_url: matched };
  }
  const existing = output.existing === "yes" ? "not_sure" : output.existing;
  return { ...output, existing, existing_url: "" };
}

/**
 * Never report a confident "no" when stage-1 could not actually confirm. If the
 * candidate list is empty *because* every resolve failed (chunks were returned
 * but none resolved — the transient-failure signature, e.g. the Workers
 * subrequest cap), a "no" is not trustworthy: a real, live article may have
 * been missed. Downgrade it to `not_sure` and annotate the note so the operator
 * double-checks. A genuine empty grounding (`resolve_failures === 0`) is left
 * untouched.
 */
function applyDegradedGuard(
  output: TopicDedupOutput,
  candidates: ExistingArticle[],
  diagnostics: Stage1Diagnostics,
): TopicDedupOutput {
  if (candidates.length === 0 && diagnostics.resolve_failures > 0 && output.existing === "no") {
    return {
      ...output,
      existing: "not_sure",
      existing_note: output.existing_note + DEGRADED_NOTE_SUFFIX,
    };
  }
  return output;
}

/**
 * Run the two-stage topic-dedup for one candidate. `sql` backs the stage-1 URL
 * resolver (vertexaisearch redirect → real URL, cached in url_resolution_cache).
 * `resolve` is injectable for tests; it defaults to the sql-backed resolver.
 * Returns the verdict, token usage, and the stage-1 diagnostics (persisted for
 * observability).
 */
export async function runTopicDedup(
  sql: Sql,
  gemini: GeminiClient,
  input: TopicDedupInput,
  resolve: UrlResolveFn = (uri) => resolveUrl(sql, uri),
): Promise<{ output: TopicDedupOutput; tokens: TopicDedupTokens; stage1: Stage1Diagnostics }> {
  const stage1 = await runExistingArticleSearch(sql, gemini, resolve, {
    topic: input.topic,
    keywords: input.keywords,
    voiceSlug: input.voiceSlug,
  });
  const candidates = stage1.articles;

  const systemPrompt = await buildSystemPrompt(sql, input.voiceSlug);
  const userPrompt = buildUserPrompt(
    { topic: input.topic, keywords: input.keywords },
    candidates,
  );

  const result = await gemini.generate({
    agent: "topic_dedup",
    systemPrompt,
    userPrompt,
    responseSchema: TOPIC_DEDUP_SCHEMA as Record<string, unknown>,
    tools: ["urlContext"], // open the real candidate URLs to verify the match
    onThought: input.onThought,
  });

  const raw = result.parsed as unknown as TopicDedupOutput;
  const constrained = constrainToCandidates(raw, candidates);
  const output = applyDegradedGuard(constrained, candidates, stage1.diagnostics);

  return {
    output,
    tokens: {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      thinkingTokens: result.thinkingTokens,
      latencyMs: result.latencyMs,
    },
    stage1: stage1.diagnostics,
  };
}
