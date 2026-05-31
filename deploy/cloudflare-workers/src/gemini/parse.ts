/**
 * JSON parsing + schema helpers for the Gemini client.
 *
 * Ported from `content_tool/gemini/client.py`:
 *  - `parse_gemini_json` -> `parseGeminiJson`
 *  - `strip_property_ordering` -> `stripPropertyOrdering`
 */

const ERROR_SNIPPET_LENGTH = 200;

/**
 * Recursively remove every `propertyOrdering` key from objects/arrays.
 *
 * The SDK rejects `propertyOrdering` on `responseJsonSchema` with
 * INVALID_ARGUMENT, so we strip it before sending the schema.
 */
export function stripPropertyOrdering(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => stripPropertyOrdering(item));
  }
  if (isPlainObject(schema)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "propertyOrdering") {
        continue;
      }
      result[key] = stripPropertyOrdering(value);
    }
    return result;
  }
  return schema;
}

/**
 * Parse JSON emitted by Gemini, tolerating the shapes it actually returns.
 *
 * Gemini occasionally wraps the JSON in a ```json (or bare ```) fence or adds
 * leading/trailing commentary, especially when grounding tools are enabled.
 * Strategy:
 *  1. Strip a leading/trailing code fence if present.
 *  2. Try a direct `JSON.parse`.
 *  3. Fall back to extracting the first balanced `{...}` object substring.
 *  4. If nothing valid is found, throw with the first 200 chars.
 */
export function parseGeminiJson(text: string): Record<string, unknown> {
  if (!text) {
    return {};
  }

  const candidate = stripCodeFence(text.trim());

  const direct = tryParseObject(candidate);
  if (direct !== null) {
    return direct;
  }

  const balanced = extractFirstBalancedObject(candidate);
  if (balanced !== null) {
    const parsed = tryParseObject(balanced);
    if (parsed !== null) {
      return parsed;
    }
  }

  const snippet = text.slice(0, ERROR_SNIPPET_LENGTH).replace(/\n/g, " ");
  throw new Error(
    `Gemini response is not valid JSON (len=${text.length}). ` +
      `First ${ERROR_SNIPPET_LENGTH} chars: ${JSON.stringify(snippet)}`,
  );
}

/** Remove a wrapping ```json ... ``` (or bare ```) fence, if present. */
function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) {
    return text;
  }
  // Drop the opening fence line (e.g. "```json" or "```").
  const afterFirstLine = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
  // Drop a trailing closing fence if present.
  const closingIndex = afterFirstLine.lastIndexOf("```");
  const body = closingIndex >= 0 ? afterFirstLine.slice(0, closingIndex) : afterFirstLine;
  return body.trim();
}

/** Attempt to JSON.parse `text` into a plain object; return null on any failure. */
function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Find the first balanced `{...}` substring, respecting strings/escapes, and
 * return it (without parsing). Returns null if no balanced object is found.
 */
function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (char === "\\") {
      isEscaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
