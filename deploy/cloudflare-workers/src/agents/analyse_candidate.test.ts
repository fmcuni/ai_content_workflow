import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Sql } from "postgres";

// Mock the two heavy agents so this test isolates analyseCandidateVerdict's own
// contract (verdict persistence + last_error toggle), not the search internals.
vi.mock("./topic_dedup", () => ({ runTopicDedup: vi.fn() }));
vi.mock("./topic_hot", () => ({ runTopicHot: vi.fn() }));

import { analyseCandidateVerdict, resolveVoice, toStringArray } from "./analyse_candidate";
import { runTopicDedup } from "./topic_dedup";
import { runTopicHot } from "./topic_hot";

const DEDUP_OK = {
  output: { existing: "no", existing_note: "新題目", existing_url: null },
  tokens: {},
  stage1: { grounding_chunks: 0, bowtie_hits: 0, resolve_failures: 0, filtered_out: 0,
    attempt_cap_hit: false, grounding_empty: true, second_pass: false },
};
const HOT_OK = { output: { hot_topic: "yes", hot_topic_note: "熱門" }, tokens: {} };

/** Fake sql: returns one candidate row for the SELECT, records every other statement. */
function makeFakeSql(recorded: string[]): Sql {
  const tag = (strings: TemplateStringsArray): unknown => {
    const text = strings.join("?");
    if (text.includes("SELECT topic, keywords, persona_slug")) {
      return Promise.resolve([{ topic: "自願醫保", keywords: ["VHIS"], persona_slug: null }]);
    }
    recorded.push(text);
    return Promise.resolve([]);
  };
  // toJsonb calls sql.json — identity is enough for the fake.
  (tag as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
  return tag as unknown as Sql;
}

describe("resolveVoice / toStringArray", () => {
  it("resolveVoice falls back to DEFAULT_VOICE", () => {
    expect(resolveVoice(null, undefined)).toBe("bowtie-editor");
    expect(resolveVoice(null, "bowtie-en-my")).toBe("bowtie-en-my");
  });
  it("toStringArray parses jsonb text and rejects non-arrays", () => {
    expect(toStringArray('["a","b"]')).toEqual(["a", "b"]);
    expect(toStringArray("not json")).toEqual([]);
    expect(toStringArray(42)).toEqual([]);
  });
});

describe("analyseCandidateVerdict", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists both verdicts and clears last_error on success", async () => {
    vi.mocked(runTopicDedup).mockResolvedValue(DEDUP_OK as never);
    vi.mocked(runTopicHot).mockResolvedValue(HOT_OK as never);
    const recorded: string[] = [];

    const ok = await analyseCandidateVerdict(makeFakeSql(recorded), {} as never, "c1", null);

    expect(ok).toBe(true);
    const update = recorded.join("\n");
    expect(update).toContain("UPDATE content_tool.topic_candidates");
    expect(update).toContain("existing =");
    expect(update).toContain("last_error = NULL");
  });

  it("records last_error and leaves verdicts untouched when an agent throws", async () => {
    vi.mocked(runTopicDedup).mockRejectedValue(new Error("gemini 503"));
    vi.mocked(runTopicHot).mockResolvedValue(HOT_OK as never);
    const recorded: string[] = [];

    const ok = await analyseCandidateVerdict(makeFakeSql(recorded), {} as never, "c1", null);

    expect(ok).toBe(false);
    const update = recorded.join("\n");
    expect(update).toContain("SET last_error =");
    expect(update).not.toContain("existing =");
  });
});
