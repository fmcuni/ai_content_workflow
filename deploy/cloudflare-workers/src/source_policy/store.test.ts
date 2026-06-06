/**
 * Unit tests for src/source_policy/store.ts — per-voice resolution.
 *
 * A recording fake `sql` returns a policy row per voice based on the bound
 * `voice_slug` value, so we can exercise the `voice -> __shared__ -> bundled`
 * fallback chain without a DB. The module-level cache is reset before each test.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Sql } from "postgres";
import { snapshot, getPolicy, invalidate, fallbackSnapshot, SHARED_VOICE } from "./store";

interface FakeRow {
  body: string;
  sha256: string;
  bytes: number;
}

// A well-formed canonical policy body (parseable by cleanPolicy).
function bodyFor(domain: string): string {
  return JSON.stringify({
    deny: { domains: [domain] },
    prefer: { tlds: [], domains: [] },
    community_exception: { topic_categories: [], allowed_domains: [] },
  });
}

function makeFakeSql(rowsByVoice: Record<string, FakeRow | undefined>): Sql {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = strings.join("?");
    if (text.includes("FROM content_tool.source_policy")) {
      const voice = values[0] as string;
      const r = rowsByVoice[voice];
      return Promise.resolve(
        r ? [{ voice_slug: voice, body: r.body, sha256: r.sha256, bytes: r.bytes }] : [],
      );
    }
    return Promise.resolve([]);
  };
  return tag as unknown as Sql;
}

describe("source_policy store — per-voice resolution", () => {
  beforeEach(() => invalidate());

  it("returns the voice's own row when present", async () => {
    const sql = makeFakeSql({
      "voice-a": { body: bodyFor("competitor.example"), sha256: "aaa", bytes: 10 },
      [SHARED_VOICE]: { body: bodyFor("shared.example"), sha256: "sss", bytes: 20 },
    });
    const snap = await snapshot(sql, "voice-a");
    expect(snap.voiceSlug).toBe("voice-a");
    expect(snap.sha256).toBe("aaa");
    expect([...snap.raw.deny.domains]).toEqual(["competitor.example"]);
  });

  it("falls back to the __shared__ row when the voice has none", async () => {
    const sql = makeFakeSql({
      [SHARED_VOICE]: { body: bodyFor("shared.example"), sha256: "sss", bytes: 20 },
    });
    const snap = await snapshot(sql, "voice-a");
    // The resolved row is the shared seed (its own voice_slug).
    expect(snap.voiceSlug).toBe(SHARED_VOICE);
    expect(snap.sha256).toBe("sss");
  });

  it("falls back to the bundled YAML constant when neither row exists", async () => {
    const sql = makeFakeSql({});
    const snap = await snapshot(sql, "voice-a");
    const fallback = await fallbackSnapshot("voice-a");
    expect(snap.voiceSlug).toBe("voice-a");
    expect(snap.sha256).toBe(fallback.sha256);
    expect(snap.body).toBe(fallback.body);
  });

  it("getPolicy evaluates against the voice's resolved deny list", async () => {
    const sql = makeFakeSql({
      "voice-a": { body: bodyFor("competitor.example"), sha256: "aaa", bytes: 10 },
    });
    const policy = await getPolicy(sql, "voice-a");
    expect(policy.denyDomains.has("competitor.example")).toBe(true);
  });
});
