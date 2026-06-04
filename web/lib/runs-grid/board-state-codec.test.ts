import { describe, expect, test } from "vitest";

import {
  boolDecode,
  boolEncode,
  densityDecode,
  densityEncode,
  nextDensity,
  parseTab,
} from "./board-state-codec";

describe("parseTab", () => {
  test("passes through known tab keys", () => {
    expect(parseTab("rewrite")).toBe("rewrite");
    expect(parseTab("create")).toBe("create");
    expect(parseTab("topic_gen")).toBe("topic_gen");
    expect(parseTab("all")).toBe("all");
  });

  test("falls back to 'all' for null / empty / unknown", () => {
    expect(parseTab(null)).toBe("all");
    expect(parseTab("")).toBe("all");
    expect(parseTab("bogus")).toBe("all");
  });
});

describe("bool codec", () => {
  test("round-trips true and false through localStorage form", () => {
    expect(boolDecode(boolEncode(true))).toBe(true);
    expect(boolDecode(boolEncode(false))).toBe(false);
  });

  test("encodes to the stable '1'/'0' strings", () => {
    expect(boolEncode(true)).toBe("1");
    expect(boolEncode(false)).toBe("0");
  });

  test("treats anything other than '1' as false", () => {
    expect(boolDecode("0")).toBe(false);
    expect(boolDecode("true")).toBe(false);
    expect(boolDecode("")).toBe(false);
  });
});

describe("density codec", () => {
  test("round-trips both densities", () => {
    expect(densityDecode(densityEncode("compact"))).toBe("compact");
    expect(densityDecode(densityEncode("comfortable"))).toBe("comfortable");
  });

  test("defaults unknown stored values to comfortable", () => {
    expect(densityDecode("garbage")).toBe("comfortable");
  });

  test("nextDensity toggles between the two", () => {
    expect(nextDensity("comfortable")).toBe("compact");
    expect(nextDensity("compact")).toBe("comfortable");
  });
});
