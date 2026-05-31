/**
 * Composite staleness scoring + LLM-audit wrapper for refresh — Workers-native
 * port of `content_tool/refresh/evaluator.py`.
 *
 * `computeStaleness` reproduces the Python weighted score and action thresholds
 * exactly. `llmAuditPublished` reuses the existing "audit" prompt template +
 * persona system prompt + AUDIT_OUTPUT_SCHEMA (via DoGeminiClient), audits the
 * published HTML with empty gap/citation context, and returns finding counts +
 * token usage.
 */

import type { Sql } from "postgres";

import { getRefreshConfig } from "../config/refresh";
import type { DeterministicResult } from "./deterministic_checks";
import { getAssembled } from "../prompts/store";
import { loadPersona, toPromptBlock } from "../agents/persona";
import { AUDIT_OUTPUT_SCHEMA, type AuditOutput } from "../agents/schemas";
import type { GeminiClient } from "../gemini/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Action = "refresh" | "monitor" | "ok";

export interface LLMFindings {
  severityHigh: number;
  severityMedium: number;
  severityLow: number;
  raw: Record<string, unknown> | null;
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
  model: string | null;
}

export interface StalenessResult {
  /** 0.00–10.00, rounded to 2 decimal places (matches Python Decimal(":.2f")). */
  score: number;
  action: Action;
}

// ---------------------------------------------------------------------------
// compute_staleness
// ---------------------------------------------------------------------------

/** Round to 2 decimals, the way Python's `Decimal(f"{x:.2f}")` does. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Weighted staleness score + recommended action.
 *
 * score = age_weight * age_factor
 *       + det_high_weight   * det.severityHigh   * 10
 *       + det_medium_weight * det.severityMedium * 5
 *       + llm_weight        * llm_factor
 * clamped to [0, 10] and rounded to 2dp, where
 *   age_factor = min(10, 10 * ageDays / age_full_score_days)
 *   llm_factor = 10 if llm.high>0 else 5 if llm.medium>0 else 0 (0 when no llm)
 *
 * action = "refresh" if score >= refresh_threshold OR any high severity
 *          (det OR llm); else "monitor" if score >= monitor_threshold; else "ok".
 */
export function computeStaleness(
  det: DeterministicResult,
  llm: LLMFindings | null,
  ageDays: number,
): StalenessResult {
  const cfg = getRefreshConfig().scoring;

  const ageFactor = Math.min(10.0, (10.0 * ageDays) / cfg.age_full_score_days);

  let llmFactor: number;
  if (llm === null) {
    llmFactor = 0.0;
  } else if (llm.severityHigh > 0) {
    llmFactor = 10.0;
  } else if (llm.severityMedium > 0) {
    llmFactor = 5.0;
  } else {
    llmFactor = 0.0;
  }

  const rawScore =
    cfg.age_weight * ageFactor +
    cfg.det_high_weight * det.severityHigh * 10.0 +
    cfg.det_medium_weight * det.severityMedium * 5.0 +
    cfg.llm_weight * llmFactor;

  const score = round2(Math.max(0.0, Math.min(10.0, rawScore)));

  const hasHighSeverity = det.severityHigh > 0 || (llm !== null && llm.severityHigh > 0);
  let action: Action;
  if (score >= cfg.refresh_threshold || hasHighSeverity) {
    action = "refresh";
  } else if (score >= cfg.monitor_threshold) {
    action = "monitor";
  } else {
    action = "ok";
  }

  return { score, action };
}

// ---------------------------------------------------------------------------
// llm_audit_published
// ---------------------------------------------------------------------------

/**
 * json.dumps(..., ensure_ascii=False) parity — Python uses ", " / ": "
 * separators. Re-introduce a space after structural `:`/`,` outside strings so
 * the prompt bytes match the Python source exactly (mirrors audit.ts).
 */
function reSpaceJson(compact: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of compact) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (!inString && (ch === ":" || ch === ",")) {
      out += ch + " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function pyJsonDumps(value: unknown): string {
  return reSpaceJson(JSON.stringify(value));
}

/** YYYY-MM-DD in UTC — mirrors Python `date.today()` slotted into the template. */
function todayDateUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface LlmAuditInput {
  html: string;
  persona: string | null;
}

/**
 * Run the existing "audit" prompt against published HTML.
 *
 * Reuses `getAssembled(sql, "audit")` + the persona system prompt
 * (`toPromptBlock`, glossary filtered to the html body) and the AUDIT_OUTPUT
 * schema. Non-HTML context fields (gap_update_plan, citation_intents,
 * citations_summary, deterministic_findings) are passed empty, matching the
 * Python evaluator's published-content path.
 */
export async function llmAuditPublished(
  sql: Sql,
  gemini: GeminiClient,
  input: LlmAuditInput,
): Promise<LLMFindings> {
  const personaSlug = input.persona ?? "bowtie-editor";
  const persona = await loadPersona(sql, personaSlug);
  const template = await getAssembled(sql, "audit");

  const systemPrompt = template
    .replace("{persona_block}", toPromptBlock(persona, input.html))
    .replace("{today_date}", todayDateUtc());

  const userPrompt =
    `# final_html\n${input.html}\n\n` +
    `# gap_analysis.update_plan\n${pyJsonDumps({})}\n\n` +
    `# citation_intents\n${pyJsonDumps([])}\n\n` +
    `# citations (resolved)\n${pyJsonDumps([])}\n\n` +
    `# deterministic_findings\n${pyJsonDumps([])}`;

  const result = await gemini.generate({
    agent: "audit",
    systemPrompt,
    userPrompt,
    responseSchema: AUDIT_OUTPUT_SCHEMA as Record<string, unknown>,
    tools: [],
  });

  const output = result.parsed as unknown as AuditOutput;
  const findings = output.findings ?? [];

  return {
    severityHigh: findings.filter((f) => f.severity === "high").length,
    severityMedium: findings.filter((f) => f.severity === "medium").length,
    severityLow: findings.filter((f) => f.severity === "low").length,
    raw: result.parsed,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    thinkingTokens: result.thinkingTokens,
    latencyMs: result.latencyMs,
    model: null,
  };
}
