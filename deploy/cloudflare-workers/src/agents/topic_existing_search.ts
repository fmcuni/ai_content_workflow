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
 * Resolves a vertexaisearch redirect URI to its final URL + apex domain. The
 * workflow wires `(uri) => resolveUrl(sql, uri)`; tests inject a stub. Injecting
 * it keeps this agent free of network so it stays unit-testable.
 */
export type UrlResolveFn = (uri: string) => Promise<ResolvedUrl>;

interface GroundingWeb {
  uri?: string;
  title?: string;
}

async function buildSystemPrompt(sql: Sql): Promise<string> {
  return getAssembled(sql, "topic_existing_search");
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
 * Grounded search → resolved real bowtie article URLs (deduped, capped).
 *
 * Returns an empty array when the model found no grounded bowtie article — the
 * correct, non-hallucinated "nothing exists yet" signal for stage 2.
 */
export async function runExistingArticleSearch(
  sql: Sql,
  gemini: GeminiClient,
  resolve: UrlResolveFn,
  input: { topic: string; keywords: string[] },
): Promise<ExistingArticle[]> {
  const systemPrompt = await buildSystemPrompt(sql);
  const userPrompt = buildUserPrompt(input);

  const result = await gemini.generate({
    agent: "topic_existing_search",
    systemPrompt,
    userPrompt,
    responseSchema: null, // plain text — we harvest grounding, not the prose
    tools: ["googleSearch"],
  });

  const seen = new Set<string>();
  const articles: ExistingArticle[] = [];
  let attempts = 0;
  for (const chunk of result.groundingChunks ?? []) {
    const web = (chunk as { web?: GroundingWeb }).web;
    const vertexUri = web?.uri;
    if (!vertexUri) continue;
    if (attempts >= MAX_RESOLVE_ATTEMPTS) break;
    attempts += 1;
    const resolved = await resolve(vertexUri);
    const finalUrl = resolved.finalUrl;
    if (!finalUrl || resolved.domain !== BOWTIE_DOMAIN) continue;
    const key = finalUrl.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    articles.push({ url: finalUrl, title: web?.title ?? null });
    if (articles.length >= MAX_CANDIDATES) break;
  }
  return articles;
}
