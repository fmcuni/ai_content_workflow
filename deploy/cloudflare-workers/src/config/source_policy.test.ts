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

describe("source_policy — editable prompt_block template", () => {
  it("substitutes list tokens (matching the Python _render_template)", () => {
    const policy = new SourcePolicy({
      prefer: { tlds: [".gov.hk"], domains: ["who.int", "ia.org.hk"] },
      community_exception: {
        topic_categories: ["community-response"],
        allowed_domains: ["reddit.com"],
      },
      prompt_block:
        "RULES TLD={prefer_tlds} ORG={prefer_domains} " +
        "CAT={community_categories} FORUM={community_domains}",
    });
    expect(policy.toPromptBlock()).toBe(
      "RULES TLD=.gov.hk ORG=ia.org.hk、who.int CAT=community-response FORUM=reddit.com",
    );
  });

  it("overrides the default prose entirely", () => {
    const policy = new SourcePolicy({ prompt_block: "只有這一行。" });
    const block = policy.toPromptBlock();
    expect(block).toBe("只有這一行。");
    expect(block).not.toContain("引用與資料來源規則");
  });

  it("renders {denied_tlds_line} when denied TLDs are set", () => {
    const policy = new SourcePolicy({
      deny: { tlds: [".cn"] },
      prompt_block: "A\n{denied_tlds_line}\nB",
    });
    expect(policy.toPromptBlock()).toBe(
      "A\n- 額外硬性禁止：不可引用屬於以下頂級域名（TLD）的來源：cn。\nB",
    );
  });

  it("drops {denied_tlds_line} and its trailing newline when no denied TLDs", () => {
    const policy = new SourcePolicy({ prompt_block: "A\n{denied_tlds_line}\nB" });
    expect(policy.toPromptBlock()).toBe("A\nB");
  });

  it("treats a whitespace-only template as unset (default block)", () => {
    const policy = new SourcePolicy({ prompt_block: "   \n  " });
    expect(policy.toPromptBlock()).toContain("引用與資料來源規則");
  });

  it("serialises prompt_block last, byte-identical to Python canonical_json", () => {
    expect(canonicalPolicyJson({ prompt_block: "只有這一行。" })).toBe(
      '{"deny":{"domains":[],"tlds":[]},' +
        '"prefer":{"tlds":[],"domains":[]},' +
        '"community_exception":{"topic_categories":[],"allowed_domains":[]},' +
        '"prompt_block":"只有這一行。"}',
    );
  });

  it("omits prompt_block from canonical JSON when empty", () => {
    expect(canonicalPolicyJson({ prompt_block: "   " })).toBe(
      '{"deny":{"domains":[],"tlds":[]},' +
        '"prefer":{"tlds":[],"domains":[]},' +
        '"community_exception":{"topic_categories":[],"allowed_domains":[]}}',
    );
  });
});
