// Unit tests for the hand-rolled CSV helpers in compliance.ts. These cover the
// RFC4180-style escaping that must match Python `csv.writer` (QUOTE_MINIMAL):
// quote on comma/quote/CR/LF, double internal quotes, CRLF line terminator.
// No DB is touched.

import { describe, expect, it } from "vitest";
import { buildCsv, csvEscape, csvRow } from "./compliance";

describe("csvEscape", () => {
  it("leaves a plain field unquoted", () => {
    expect(csvEscape("hello")).toBe("hello");
  });

  it("leaves an empty field unquoted", () => {
    expect(csvEscape("")).toBe("");
  });

  it("quotes a field containing a comma", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  it("quotes and doubles an embedded double-quote", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("quotes a field containing a carriage return", () => {
    expect(csvEscape("line1\rline2")).toBe('"line1\rline2"');
  });

  it("does not quote a field that merely contains spaces", () => {
    expect(csvEscape("a b c")).toBe("a b c");
  });
});

describe("csvRow", () => {
  it("joins escaped fields with a comma and no trailing newline", () => {
    expect(csvRow(["a", "b,c", 'd"e'])).toBe('a,"b,c","d""e"');
  });
});

describe("buildCsv", () => {
  it("emits a CRLF after the header and each data row", () => {
    const out = buildCsv(["h1", "h2"], [["a", "b"], ["c,d", "e"]]);
    expect(out).toBe("h1,h2\r\na,b\r\n\"c,d\",e\r\n");
  });

  it("emits only the header (with trailing CRLF) when there are no rows", () => {
    expect(buildCsv(["h1", "h2"], [])).toBe("h1,h2\r\n");
  });
});
