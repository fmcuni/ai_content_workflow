import type { Sql } from "postgres";
import { sourcePolicyInstance, type Decision } from "../config/source_policy";
import { resolveUrl } from "./url_resolver";

// Cap on concurrent URL resolutions. Citation resolution runs inside a Workflow
// step (its own subrequest budget), but we still bound in-flight HEAD requests
// to stay well under the per-invocation subrequest ceiling.
const MAX_IN_FLIGHT = 8;

// Decisions that make a citation eligible for display in the sources section.
const DISPLAYABLE_DECISIONS: ReadonlySet<Decision> = new Set([
  "allowed",
  "community_exception",
]);

export interface GroundingChunk {
  web?: {
    uri?: string;
    title?: string;
  };
}

export interface ResolveCitationsInput {
  draftId: string;
  markupRaw: string;
  groundingChunks: readonly GroundingChunk[];
  topicCategory: string | null;
}

export interface ResolveCitationsResult {
  finalMarkup: string;
  displayedCount: number;
}

// Per-chunk resolution outcome, retaining iteration order via `chunkIdx`.
interface CitationRecord {
  chunkIdx: number;
  vertexUri: string;
  finalUrl: string | null;
  domain: string | null;
  title: string | null;
  policyDecision: Decision;
  deniedReason: string | null;
  wasDisplayed: boolean;
  resolutionError: string | null;
}

/**
 * Build the `## 資訊來源` section from the displayed citations, in iteration
 * order (no sort, no dedup). Mirrors Python `_build_sources_md`: leading blank
 * line + header, 1-indexed `{i}. [{domain}]({url})`, trailing newline. Returns
 * "" when nothing is displayed (no header emitted).
 */
function buildSourcesMd(displayed: readonly { domain: string; finalUrl: string }[]): string {
  if (displayed.length === 0) return "";
  const lines = ["", "## 資訊來源"];
  displayed.forEach(({ domain, finalUrl }, i) => {
    lines.push(`${i + 1}. [${domain}](${finalUrl})`);
  });
  return lines.join("\n") + "\n";
}

/**
 * Resolve a single grounding chunk's URI through the URL resolver + source
 * policy. Mirrors the Python loop body: a null domain is treated as
 * `denied`/`unknown_domain` without consulting the policy.
 */
async function resolveChunk(
  sql: Sql,
  chunk: GroundingChunk,
  chunkIdx: number,
  topicCategory: string | null,
): Promise<CitationRecord | null> {
  const vertexUri = chunk.web?.uri;
  const title = chunk.web?.title ?? null;
  if (!vertexUri) return null;

  const resolved = await resolveUrl(sql, vertexUri);
  const domain = resolved.domain;

  let policyDecision: Decision;
  let deniedReason: string | null;
  if (domain) {
    const decision = sourcePolicyInstance.evaluate(domain, topicCategory);
    policyDecision = decision.decision;
    deniedReason = decision.reason;
  } else {
    policyDecision = "denied";
    deniedReason = "unknown_domain";
  }

  const wasDisplayed =
    DISPLAYABLE_DECISIONS.has(policyDecision) && resolved.finalUrl !== null;

  return {
    chunkIdx,
    vertexUri,
    finalUrl: resolved.finalUrl,
    domain,
    title,
    policyDecision,
    deniedReason,
    wasDisplayed,
    resolutionError: resolved.error,
  };
}

/**
 * Run resolution over all chunks with bounded concurrency, preserving input
 * order in the returned array (skipped uri-less chunks produce null).
 */
async function resolveAllChunks(
  sql: Sql,
  chunks: readonly GroundingChunk[],
  topicCategory: string | null,
): Promise<(CitationRecord | null)[]> {
  const results: (CitationRecord | null)[] = new Array(chunks.length).fill(null);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const idx = next;
      next += 1;
      if (idx >= chunks.length) return;
      const chunk = chunks[idx];
      if (chunk === undefined) continue;
      results[idx] = await resolveChunk(sql, chunk, idx, topicCategory);
    }
  }

  const workerCount = Math.min(MAX_IN_FLIGHT, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function insertCitation(
  sql: Sql,
  draftId: string,
  record: CitationRecord,
): Promise<void> {
  await sql`
    INSERT INTO content_tool.citations
      (citation_id, draft_id, chunk_idx, vertex_uri, final_url, domain, title,
       policy_decision, denied_reason, was_displayed, resolution_error)
    VALUES (
      gen_random_uuid(),
      ${draftId},
      ${record.chunkIdx},
      ${record.vertexUri},
      ${record.finalUrl},
      ${record.domain},
      ${record.title},
      ${record.policyDecision},
      ${record.deniedReason},
      ${record.wasDisplayed},
      ${record.resolutionError}
    )
  `;
}

/**
 * Resolve every grounding chunk for a draft: persist one `content_tool.citations`
 * row per chunk, build the 繁體中文 sources section from the displayed ones, and
 * return the composed final markup + displayed count.
 *
 * Final markup join mirrors Python exactly:
 *   final_markup = markup_raw.rstrip() + "\n" + sources_md
 * where `sources_md` is "" when nothing is displayed.
 */
export async function resolveCitations(
  sql: Sql,
  input: ResolveCitationsInput,
): Promise<ResolveCitationsResult> {
  const { draftId, markupRaw, groundingChunks, topicCategory } = input;

  const records = await resolveAllChunks(sql, groundingChunks, topicCategory);

  const displayed: { domain: string; finalUrl: string }[] = [];
  for (const record of records) {
    if (record === null) continue;
    await insertCitation(sql, draftId, record);
    if (record.wasDisplayed && record.finalUrl !== null && record.domain !== null) {
      displayed.push({ domain: record.domain, finalUrl: record.finalUrl });
    }
  }

  const sourcesMd = buildSourcesMd(displayed);
  const finalMarkup = markupRaw.replace(/\s+$/, "") + "\n" + sourcesMd;

  return { finalMarkup, displayedCount: displayed.length };
}
