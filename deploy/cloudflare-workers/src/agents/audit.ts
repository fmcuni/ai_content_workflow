/**
 * Audit agent — TypeScript port of `content_tool/agents/audit.py` (`run_audit`).
 *
 * Computes the PIPELINE deterministic format/citation checks
 * (runDeterministicChecks), runs the LLM audit, merges the two finding sets,
 * recomputes the severity summary + overall_pass, and persists one
 * `content_tool.audit_runs` row per draft (DELETE-then-INSERT for idempotency,
 * matching the Python node).
 */

import type { Sql } from "postgres";
import { toJsonb } from "../db/serialize";

import { getAssembled } from "../prompts/store";
import type { GeminiClient, ThoughtCallback } from "../gemini/types";
import { AUDIT_OUTPUT_SCHEMA, type AuditFinding, type AuditOutput } from "./schemas";
import { loadPersona, toPromptBlock } from "./persona";
import { runDeterministicChecks } from "./audit_checks";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface AuditRunContext {
  runId: string;
  /** Persona slug (column `run.persona`). */
  persona: string;
}

export interface AuditInput {
  run: AuditRunContext;
  draftId: string;
  htmlBody: string;
  /** Refresh runs supply gap_analysis.update_plan; create runs omit it. */
  gapUpdatePlan?: object;
  citationIntents: object[];
  citationsSummary: object[];
  schemaJsonld: object[] | null;
  citationsDeniedDisplayed: boolean;
  todayDate: string; // YYYY-MM-DD
  onThought?: ThoughtCallback;
}

export interface AuditTokens {
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// json.dumps(..., ensure_ascii=False) parity
//
// Python's json.dumps uses item/key separators ", " and ": " (with spaces) by
// default. JSON.stringify uses no spaces. Re-introduce the spaces so the prompt
// bytes match the Python source exactly. ensure_ascii=False ⇒ keep raw UTF-8,
// which JSON.stringify already does.
// ---------------------------------------------------------------------------

function pyJsonDumps(value: unknown): string {
  // JSON.stringify with two-space indent, then collapse the pretty-printing
  // back to Python's compact-with-spaces form is brittle; instead serialise
  // compactly and re-space the structural separators that sit outside strings.
  return reSpaceJson(JSON.stringify(value));
}

/**
 * Insert a space after structural `:` and `,` separators that are NOT inside a
 * JSON string literal, reproducing Python's default `", "` / `": "` separators.
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

// ---------------------------------------------------------------------------
// Prompt assembly — mirrors Python build_system_prompt / build_user_prompt
// ---------------------------------------------------------------------------

async function buildSystemPrompt(
  sql: Sql,
  personaSlug: string,
  htmlBody: string,
  todayDate: string,
): Promise<string> {
  const persona = await loadPersona(sql, personaSlug);
  const template = await getAssembled(sql, "audit");
  // The audit system prompt filters the glossary to terms present in the draft
  // (context_text = html_body), matching the Python call site.
  return template
    .replace("{persona_block}", toPromptBlock(persona, htmlBody))
    .replace("{today_date}", todayDate);
}

function buildUserPrompt(opts: {
  htmlBody: string;
  gapUpdatePlan: object;
  citationIntents: object[];
  citationsSummary: object[];
  deterministicFindings: AuditFinding[];
}): string {
  return (
    `# final_html\n${opts.htmlBody}\n\n` +
    `# gap_analysis.update_plan\n${pyJsonDumps(opts.gapUpdatePlan)}\n\n` +
    `# citation_intents\n${pyJsonDumps(opts.citationIntents)}\n\n` +
    `# citations (resolved)\n${pyJsonDumps(opts.citationsSummary)}\n\n` +
    `# deterministic_findings\n${pyJsonDumps(opts.deterministicFindings)}`
  );
}

// ---------------------------------------------------------------------------
// Merge — mirrors the Python recompute exactly:
//   combined = llm.findings + deterministic
//   high/medium/low = counts over combined by severity
//   overall_pass = high == 0 && !any(must_fix)
// ---------------------------------------------------------------------------

function mergeAudit(llm: AuditOutput, deterministic: AuditFinding[]): AuditOutput {
  const combined = [...llm.findings, ...deterministic];

  const high = combined.filter((f) => f.severity === "high").length;
  const medium = combined.filter((f) => f.severity === "medium").length;
  const low = combined.filter((f) => f.severity === "low").length;
  const anyMustFix = combined.some((f) => f.must_fix);

  return {
    overall_pass: high === 0 && !anyMustFix,
    severity_summary: { high, medium, low },
    findings: combined,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the audit node for a single draft: deterministic checks + LLM audit,
 * merge, persist, and return the merged AuditOutput plus token usage.
 */
export async function runAudit(
  sql: Sql,
  gemini: GeminiClient,
  input: AuditInput,
): Promise<{ audit: AuditOutput; tokens: AuditTokens }> {
  const deterministicFindings = runDeterministicChecks({
    htmlBody: input.htmlBody,
    citationsDeniedDisplayed: input.citationsDeniedDisplayed,
    schemaJsonld: input.schemaJsonld,
  });

  const systemPrompt = await buildSystemPrompt(
    sql,
    input.run.persona,
    input.htmlBody,
    input.todayDate,
  );
  const userPrompt = buildUserPrompt({
    htmlBody: input.htmlBody,
    gapUpdatePlan: input.gapUpdatePlan ?? {},
    citationIntents: input.citationIntents,
    citationsSummary: input.citationsSummary,
    deterministicFindings,
  });

  const result = await gemini.generate({
    agent: "audit",
    systemPrompt,
    userPrompt,
    responseSchema: AUDIT_OUTPUT_SCHEMA as Record<string, unknown>,
    tools: [],
    onThought: input.onThought,
  });

  // Gemini returns a plain object matching AuditOutput when a responseSchema is
  // supplied. Route through `unknown` to satisfy the compiler.
  const llmAudit = result.parsed as unknown as AuditOutput;

  const merged = mergeAudit(llmAudit, deterministicFindings);

  // Idempotency: the production sub-graph can re-enter this node (resume,
  // retry, refine loop). audit_runs.draft_id is UNIQUE, so DELETE first to keep
  // single-row semantics regardless of replays.
  const llmFindings = { findings: llmAudit.findings };
  const deterministic = { findings: deterministicFindings };

  await sql`
    DELETE FROM content_tool.audit_runs WHERE draft_id = ${input.draftId}
  `;
  await sql`
    INSERT INTO content_tool.audit_runs
      (audit_id, draft_id, overall_pass,
       severity_high, severity_medium, severity_low,
       llm_findings, deterministic_findings,
       tokens_in, tokens_out, latency_ms)
    VALUES (
      gen_random_uuid(),
      ${input.draftId},
      ${merged.overall_pass},
      ${merged.severity_summary.high},
      ${merged.severity_summary.medium},
      ${merged.severity_summary.low},
      ${toJsonb(sql, llmFindings)},
      ${toJsonb(sql, deterministic)},
      ${result.tokensIn},
      ${result.tokensOut},
      ${result.latencyMs}
    )
  `;

  return {
    audit: merged,
    tokens: {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      thinkingTokens: result.thinkingTokens,
      latencyMs: result.latencyMs,
    },
  };
}
