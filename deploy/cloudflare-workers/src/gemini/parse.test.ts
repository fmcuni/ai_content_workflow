import { describe, expect, it } from "vitest";

import { parseGeminiJson, stripPropertyOrdering } from "./parse";

describe("parseGeminiJson", () => {
  it("parses plain JSON", () => {
    // Arrange
    const text = '{"title":"hello","count":3}';

    // Act
    const result = parseGeminiJson(text);

    // Assert
    expect(result).toEqual({ title: "hello", count: 3 });
  });

  it("strips a ```json fence", () => {
    // Arrange
    const text = '```json\n{"ok":true}\n```';

    // Act
    const result = parseGeminiJson(text);

    // Assert
    expect(result).toEqual({ ok: true });
  });

  it("strips a bare ``` fence", () => {
    // Arrange
    const text = '```\n{"value":42}\n```';

    // Act
    const result = parseGeminiJson(text);

    // Assert
    expect(result).toEqual({ value: 42 });
  });

  it("extracts the first balanced object after leading prose", () => {
    // Arrange — grounding tools often prepend commentary before the JSON.
    const text = 'Here is the result you asked for:\n{"a":1,"nested":{"b":2}} Thanks!';

    // Act
    const result = parseGeminiJson(text);

    // Assert
    expect(result).toEqual({ a: 1, nested: { b: 2 } });
  });

  it("does not break on braces inside strings", () => {
    // Arrange
    const text = 'prose {"text":"a } b { c","n":1} trailing';

    // Act
    const result = parseGeminiJson(text);

    // Assert
    expect(result).toEqual({ text: "a } b { c", n: 1 });
  });

  it("returns empty object for empty input", () => {
    expect(parseGeminiJson("")).toEqual({});
  });

  it("throws on invalid JSON", () => {
    // Arrange
    const text = "this is not json at all";

    // Act + Assert
    expect(() => parseGeminiJson(text)).toThrow(/not valid JSON/);
  });
});

describe("stripPropertyOrdering", () => {
  it("removes propertyOrdering at the top level", () => {
    // Arrange
    const schema = {
      type: "object",
      propertyOrdering: ["a", "b"],
      properties: { a: { type: "string" } },
    };

    // Act
    const result = stripPropertyOrdering(schema);

    // Assert
    expect(result).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });

  it("removes propertyOrdering recursively in nested objects and arrays", () => {
    // Arrange
    const schema = {
      type: "object",
      propertyOrdering: ["x"],
      properties: {
        x: {
          type: "array",
          items: {
            type: "object",
            propertyOrdering: ["y"],
            properties: { y: { type: "number" } },
          },
        },
      },
      anyOf: [{ propertyOrdering: ["z"], type: "object" }],
    };

    // Act
    const result = stripPropertyOrdering(schema);

    // Assert
    expect(result).toEqual({
      type: "object",
      properties: {
        x: {
          type: "array",
          items: {
            type: "object",
            properties: { y: { type: "number" } },
          },
        },
      },
      anyOf: [{ type: "object" }],
    });
  });

  it("leaves primitives untouched", () => {
    expect(stripPropertyOrdering("string")).toBe("string");
    expect(stripPropertyOrdering(7)).toBe(7);
    expect(stripPropertyOrdering(null)).toBe(null);
  });
});
