// JSON / date helpers that reproduce the Python reference's byte-exact output so
// prompts assembled in the Workers port hash identically to the Python backend
// (prompt-sha parity). Shared by the writer / audit / refresh-evaluator agents;
// previously each file carried its own copy of these functions.

/**
 * Insert a space after structural `:` and `,` separators that are NOT inside a
 * JSON string literal, reproducing Python's default `", "` / `": "` separators.
 */
export function reSpaceJson(compact: string): string {
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

/**
 * Reproduce Python `json.dumps(value, ensure_ascii=False)` exactly: compact
 * `JSON.stringify` re-spaced to Python's default `", "` / `": "` separators
 * (outside string literals), with non-ASCII preserved.
 */
export function pyJsonDumps(value: unknown): string {
  return reSpaceJson(JSON.stringify(value));
}

/** YYYY-MM-DD in UTC — mirrors Python `date.today()` slotted into prompts. */
export function todayDateUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
