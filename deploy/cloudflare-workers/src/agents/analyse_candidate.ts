/**
 * Shared verdict computation for a single topic candidate (dedup + hot-topic).
 *
 * Extracted from TopicExpansionWorkflow so the same logic backs both the
 * fan-out during a batch run AND the per-candidate "retry verdict" REST route
 * (routes/topic_batches.ts) used to recover an errored candidate without
 * re-running the whole batch. Mirrors n_analyse_candidate in
 * content_tool/graph/topic_expansion.py.
 */

import type { Sql } from "postgres";

import { toJsonb } from "../db/serialize";
import type { GeminiClient } from "../gemini/types";
import { runTopicDedup } from "./topic_dedup";
import { runTopicHot } from "./topic_hot";

// Terminal fallback when neither the candidate nor the batch names a voice.
// Mirrors content_tool/graph/topic_expansion.py DEFAULT_VOICE.
export const DEFAULT_VOICE = "bowtie-editor";

/** First non-empty voice slug, else DEFAULT_VOICE (mirrors `_resolve_voice`). */
export function resolveVoice(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return DEFAULT_VOICE;
}

/** JSONB array column → string[] (postgres.js returns jsonb as raw text under fetch_types:false). */
export function toStringArray(value: unknown): string[] {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((v): v is string => typeof v === "string");
}

interface CandidateRow {
  topic: string;
  keywords: unknown;
  persona_slug: string | null;
}

/**
 * Run dedup + hot for a single candidate concurrently and persist both
 * verdicts. A failure of either agent is captured in `last_error` (the row is
 * NOT failed hard); a success clears `last_error`. Returns true iff both
 * verdicts landed (no error).
 */
export async function analyseCandidateVerdict(
  sql: Sql,
  gemini: GeminiClient,
  candidateId: string,
  personaDefault: string | null,
): Promise<boolean> {
  const rows = await sql<CandidateRow[]>`
    SELECT topic, keywords, persona_slug FROM content_tool.topic_candidates
    WHERE candidate_id = ${candidateId}::uuid LIMIT 1
  `;
  const cand = rows[0];
  if (cand === undefined) {
    throw new Error(`candidate not found: ${candidateId}`);
  }
  const topic = cand.topic;
  const keywords = toStringArray(cand.keywords);
  // Phase 0 resolution rule: candidate.persona_slug || batch default || fallback.
  const voiceSlug = resolveVoice(cand.persona_slug, personaDefault);

  try {
    const [dedup, hot] = await Promise.all([
      runTopicDedup(sql, gemini, { topic, keywords, voiceSlug }),
      runTopicHot(sql, gemini, { topic, keywords, voiceSlug }),
    ]);
    // One greppable line per candidate so an empty-candidate "no" is
    // explainable from `wrangler tail` without a DB dive (mirrors the Python
    // structlog line); the full struct is persisted below.
    console.log(
      `topic_existing_search.diagnostics topic=${JSON.stringify(topic)} ` +
        `existing=${dedup.output.existing} ` +
        `grounding_chunks=${dedup.stage1.grounding_chunks} ` +
        `bowtie_hits=${dedup.stage1.bowtie_hits} ` +
        `resolve_failures=${dedup.stage1.resolve_failures} ` +
        `filtered_out=${dedup.stage1.filtered_out} ` +
        `attempt_cap_hit=${dedup.stage1.attempt_cap_hit} ` +
        `grounding_empty=${dedup.stage1.grounding_empty} ` +
        `second_pass=${dedup.stage1.second_pass}`,
    );
    await sql`
      UPDATE content_tool.topic_candidates
      SET existing = ${dedup.output.existing},
          existing_note = ${dedup.output.existing_note},
          existing_url = ${dedup.output.existing_url},
          existing_search_debug = ${toJsonb(sql, dedup.stage1)},
          hot_topic = ${hot.output.hot_topic},
          hot_topic_note = ${hot.output.hot_topic_note},
          last_error = NULL
      WHERE candidate_id = ${candidateId}::uuid
    `;
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE content_tool.topic_candidates
      SET last_error = ${message}
      WHERE candidate_id = ${candidateId}::uuid
    `;
    return false;
  }
}
