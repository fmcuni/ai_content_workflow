/**
 * Unit tests for src/config/source_policy.ts — denied-TLD evaluation, prompt
 * rendering, and canonical-JSON key order (must stay byte-identical to the
 * Python `source_policy_store.canonical_json` so the sha256 token is portable).
 */

import { describe, it, expect } from "vitest";
import { SourcePolicy, canonicalPolicyJson } from "./source_policy";

describe("source_policy — denied TLDs", () => {
  it("serialises deny.tlds right after deny.domains, byte-identical to Python", () => {
    expect(canonicalPolicyJson({ deny: { tlds: [".cn"] } })).toBe(
      '{"deny":{"domains":[],"tlds":[".cn"]},' +
        '"prefer":{"tlds":[],"domains":[]},' +
        '"community_exception":{"topic_categories":[],"allowed_domains":[]}}',
    );
  });

  it("normalises (trim/lowercase/dedup) the canonical deny.tlds list", () => {
    const json = canonicalPolicyJson({ deny: { tlds: [" .CN ", ".cn", "RU"] } });
    expect(JSON.parse(json).deny.tlds).toEqual([".cn", "ru"]);
  });

  it("denies a source whose apex ends with a denied TLD", () => {
    const policy = new SourcePolicy({ deny: { tlds: [".cn"] } });
    const d = policy.evaluate("https://example.com.cn/page", null);
    expect(d.decision).toBe("denied");
    expect(d.reason).toBe("other");
    expect(d.matchedRule).toBe("denied-tld:cn");
  });

  it("leaves non-matching sources allowed", () => {
    const policy = new SourcePolicy({ deny: { tlds: ["cn"] } });
    expect(policy.evaluate("who.int", null).decision).toBe("allowed");
  });

  it("omits the denied-TLD line when none are configured", () => {
    const policy = new SourcePolicy();
    expect(policy.toPromptBlock()).not.toContain("額外硬性禁止");
  });

  it("renders the denied-TLD line when configured", () => {
    const policy = new SourcePolicy({ deny: { tlds: [".cn", "ru"] } });
    const block = policy.toPromptBlock();
    expect(block).toContain("額外硬性禁止");
    expect(block).toContain("cn / ru");
  });
});
