/**
 * Unit tests for src/refresh/evaluator.ts — computeStaleness scoring + action
 * thresholds. No DB / Gemini required (llmAuditPublished is integration-tested
 * live by the lead).
 */

import { describe, it, expect } from "vitest";
import { computeStaleness, type Action, type LLMFindings } from "./evaluator";
import { DeterministicResult, type Finding } from "./deterministic_checks";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function det(high: number, medium: number, low = 0): DeterministicResult {
  const r = new DeterministicResult();
  const make = (severity: Finding["severity"]): Finding => ({
    id: "x",
    severity,
    message: "m",
    context: null,
  });
  for (let i = 0; i < high; i += 1) r.add(make("high"));
  for (let i = 0; i < medium; i += 1) r.add(make("medium"));
  for (let i = 0; i < low; i += 1) r.add(make("low"));
  return r;
}

function llm(high: number, medium: number): LLMFindings {
  return {
    severityHigh: high,
    severityMedium: medium,
    severityLow: 0,
    raw: null,
    tokensIn: 0,
    tokensOut: 0,
    thinkingTokens: 0,
    latencyMs: 0,
    model: null,
  };
}

// ---------------------------------------------------------------------------
// Scoring formula
// ---------------------------------------------------------------------------

describe("computeStaleness scoring", () => {
  it("scores 0 and action 'ok' when everything is clean and fresh", () => {
    const { score, action } = computeStaleness(det(0, 0), null, 0);
    expect(score).toBe(0);
    expect(action).toBe("ok");
  });

  it("applies age_weight*age_factor (age_factor caps at 10)", () => {
    // ageDays >= age_full_score_days(180) ⇒ age_factor = 10 ⇒ 0.4*10 = 4.0
    const { score } = computeStaleness(det(0, 0), null, 180);
    expect(score).toBe(4.0);
  });

  it("rounds the age contribution to 2 decimals", () => {
    // ageDays=90 ⇒ age_factor = 10*90/180 = 5 ⇒ 0.4*5 = 2.0
    const { score } = computeStaleness(det(0, 0), null, 90);
    expect(score).toBe(2.0);
  });

  it("adds det medium contribution (det_medium_weight*medium*5)", () => {
    // 1 medium ⇒ 0.1 * 1 * 5 = 0.5, age 0 ⇒ total 0.5
    const { score } = computeStaleness(det(0, 1), null, 0);
    expect(score).toBe(0.5);
  });

  it("adds llm medium contribution (llm_weight*5) when llm has a medium finding", () => {
    // llm medium ⇒ llm_factor=5 ⇒ 0.3*5 = 1.5
    const { score } = computeStaleness(det(0, 0), llm(0, 1), 0);
    expect(score).toBe(1.5);
  });

  it("clamps the score at 10", () => {
    const { score } = computeStaleness(det(5, 5), llm(5, 0), 365);
    expect(score).toBe(10.0);
  });
});

// ---------------------------------------------------------------------------
// Action thresholds (table-driven)
// ---------------------------------------------------------------------------

describe("computeStaleness action thresholds", () => {
  interface Case {
    name: string;
    det: DeterministicResult;
    llm: LLMFindings | null;
    ageDays: number;
    expected: Action;
  }

  const cases: Case[] = [
    {
      name: "score below monitor_threshold(3) ⇒ ok",
      det: det(0, 0),
      llm: null,
      ageDays: 90, // score 2.0
      expected: "ok",
    },
    {
      name: "score >= monitor_threshold(3) and < refresh(6) ⇒ monitor",
      det: det(0, 0),
      llm: null,
      ageDays: 180, // score 4.0
      expected: "monitor",
    },
    {
      name: "score >= refresh_threshold(6) ⇒ refresh",
      det: det(0, 4), // 0.1*4*5 = 2.0
      llm: null,
      ageDays: 180, // +4.0 = 6.0
      expected: "refresh",
    },
    {
      name: "det high severity forces refresh regardless of low score",
      det: det(1, 0),
      llm: null,
      ageDays: 0,
      expected: "refresh",
    },
    {
      name: "llm high severity forces refresh regardless of low score",
      det: det(0, 0),
      llm: llm(1, 0),
      ageDays: 0,
      expected: "refresh",
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const { action } = computeStaleness(tc.det, tc.llm, tc.ageDays);
      expect(action).toBe(tc.expected);
    });
  }
});
