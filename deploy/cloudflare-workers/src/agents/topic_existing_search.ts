/**
 * Topic existing-article retrieval agent (dedup stage 1) — TypeScript port of
 * `content_tool/agents/topic_existing_search.py`.
 *
 * A single *grounded* Gemini call that searches `site:bowtie.com.hk/blog` for
 * the candidate topic and returns the REAL article URLs from the response's
 * grounding metadata — never URLs the model writes into its own text.
 *
 * Why a dedicated retrieval call: with a JSON-schema verdict request the model
 * answers the dedup question from memory and never triggers Google Search, so
 * its `existing_url` is hallucinated and the response carries zero grounding
 * chunks. Framing the call purely as retrieval reliably makes the model search,
 * populating grounding chunks with verifiable cited URLs, which we resolve via
 * the shared URL resolver (same path the writer's citation pipeline uses) and
 * filter to `bowtie.com.hk`.
 *
 * Full-width punctuation is intentional — the prompts are CJK style, matching
 * the Python `build_user_prompt` byte-for-byte.
 */

import type { Sql } from "postgres";
import { getAssembled } from "../prompts/store";
import type { GeminiClient } from "../gemini/types";
import type { ResolvedUrl } from "./url_resolver";

// The bowtie blog is the only domain the existing-article check cares about.
const BOWTIE_DOMAIN = "bowtie.com.hk";
// Cap the candidate list handed to the judge: enough to cover near-duplicates,
// small enough to keep the stage-2 urlContext verification cheap.
export const MAX_CANDIDATES = 5;
// Cap how many grounding chunks we HEAD-resolve per search. Each resolve is a
// network subrequest; on Cloudflare Workers (the prod backend) these share a
// per-invocation subrequest budget across the concurrently-analysed candidates,
// so an unbounded loop over a long, mixed grounding list can exhaust the cap and
// make every later resolve fail. Kept above MAX_CANDIDATES so a clean
// site:-scoped search (mostly bowtie hits) still fills the candidate list.
export const MAX_RESOLVE_ATTEMPTS = 12;

export interface ExistingArticle {
  url: string;
  title: string | null;
}

/**
 * Why stage-1 produced the candidate list it did — built from local loop
 * counters (zero extra subrequests) and persisted per candidate so an
 * empty-candidate "no" verdict is explainable. `resolveFailures > 0` with an
 * empty list is the transient-failure signature (e.g. the Workers subrequest
 * cap) rather than a genuine "no such article".
 *
 * Field names are snake_case to stay byte-identical to the Python
 * `Stage1Diagnostics` so the persisted `existing_search_debug` row shape is
 * shared across both backends.
 */
export interface Stage1Diagnostics {
  grounding_chunks: number;
  resolve_attempts: number;
  resolved_count: number;
  bowtie_hits: number;
  filtered_out: number;
  resolve_failures: number;
  attempt_cap_hit: boolean;
  grounding_empty: boolean;
  second_pass: boolean;
}

export interface Stage1Result {
  articles: ExistingArticle[];
  diagnostics: Stage1Diagnostics;
}

/**
 * Resolves a vertexaisearch redirect URI to its final URL + apex domain. The
 * workflow wires `(uri) => resolveUrl(sql, uri)`; tests inject a stub. Injecting
 * it keeps this agent free of network so it stays unit-testable.
 */
export type UrlResolveFn = (uri: string) => Promise<ResolvedUrl>;

interface GroundingWeb {
  uri?: string;
  title?: string;
}

async function buildSystemPrompt(sql: Sql, voiceSlug: string): Promise<string> {
  return getAssembled(sql, "topic_existing_search", voiceSlug);
}

export function buildUserPrompt(opts: { topic: string; keywords: string[] }): string {
  const keywords = opts.keywords.length > 0 ? opts.keywords.join(", ") : "（無）";
  return (
    "請用 googleSearch 實際搜尋 site:bowtie.com.hk/blog，找出與以下 topic " +
    "最相關的現有文章，列出標題與完整 URL。\n\n" +
    `topic:\n${opts.topic}\n\n` +
    `focus_keywords:\n${keywords}\n`
  );
}

/**
 * One grounded search pass: grounding chunks → resolved bowtie articles, with a
 * `Stage1Diagnostics` built from local counters so the caller can tell a genuine
 * "nothing found" apart from a resolve failure.
 */
async function searchOnce(
  gemini: GeminiClient,
  resolve: UrlResolveFn,
  systemPrompt: string,
  userPrompt: string,
  secondPass: boolean,
): Promise<Stage1Result> {
  const result = await gemini.generate({
    agent: "topic_existing_search",
    systemPrompt,
    userPrompt,
    responseSchema: null, // plain text — we harvest grounding, not the prose
    tools: ["googleSearch"],
  });

  const chunks = result.groundingChunks ?? [];
  const seen = new Set<string>();
  const articles: ExistingArticle[] = [];
  let attempts = 0;
  let resolvedCount = 0;
  let bowtieHits = 0;
  let filteredOut = 0;
  let resolveFailures = 0;
  let attemptCapHit = false;
  for (const chunk of chunks) {
    const web = (chunk as { web?: GroundingWeb }).web;
    const vertexUri = web?.uri;
    if (!vertexUri) continue;
    if (attempts >= MAX_RESOLVE_ATTEMPTS) {
      attemptCapHit = true;
      break;
    }
    attempts += 1;
    const resolved = await resolve(vertexUri);
    const finalUrl = resolved.finalUrl;
    // No final URL = a resolve *failure* (HEAD timeout, network blip, or the
    // Workers subrequest cap) — distinct from a successful resolve to a
    // non-bowtie competitor domain, which is a filter.
    if (!finalUrl) {
      resolveFailures += 1;
      continue;
    }
    resolvedCount += 1;
    if (resolved.domain !== BOWTIE_DOMAIN) {
      filteredOut += 1;
      continue;
    }
    bowtieHits += 1;
    const key = finalUrl.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    articles.push({ url: finalUrl, title: web?.title ?? null });
    if (articles.length >= MAX_CANDIDATES) break;
  }

  return {
    articles,
    diagnostics: {
      grounding_chunks: chunks.length,
      resolve_attempts: attempts,
      resolved_count: resolvedCount,
      bowtie_hits: bowtieHits,
      filtered_out: filteredOut,
      resolve_failures: resolveFailures,
      attempt_cap_hit: attemptCapHit,
      grounding_empty: chunks.length === 0,
      second_pass: secondPass,
    },
  };
}

/**
 * Grounded search → resolved real bowtie article URLs (deduped, capped) plus
 * the diagnostics explaining the result.
 *
 * Returns an empty article list when the model found no grounded bowtie article
 * — the correct, non-hallucinated "nothing exists yet" signal for stage 2.
 *
 * An empty first pass is RETRIED once. The grounded search is reliable in
 * isolation (it returns the real bowtie article for these topics); an empty
 * result almost always means a transient in-run failure — the search tool
 * returned no chunks, or every resolve failed under the Workers per-invocation
 * subrequest budget while several candidates were analysed concurrently. A
 * single retry recovers those without doubling cost on the common (non-empty)
 * path. The decisive (second) pass's diagnostics are returned, flagged
 * `second_pass: true`.
 */
export async function runExistingArticleSearch(
  sql: Sql,
  gemini: GeminiClient,
  resolve: UrlResolveFn,
  input: { topic: string; keywords: string[]; voiceSlug: string },
): Promise<Stage1Result> {
  const systemPrompt = await buildSystemPrompt(sql, input.voiceSlug);
  const userPrompt = buildUserPrompt(input);

  const first = await searchOnce(gemini, resolve, systemPrompt, userPrompt, false);
  if (first.articles.length > 0) return first;

  return searchOnce(gemini, resolve, systemPrompt, userPrompt, true);
}
