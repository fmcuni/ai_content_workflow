// Shared validation for the optional one-line change `note` accepted by the
// prompt-template and source-policy save endpoints. Mirrors the Python
// `note: str | None = Field(default=None, max_length=500)` constraint so both
// backends reject the same payloads. The note is never hashed, so canonical
// body / sha parity is unaffected.

export const MAX_NOTE_LENGTH = 500;

/**
 * Return an error message when `note` is an invalid value, or `null` when it is
 * acceptable (absent, null, or a string within the length cap).
 */
export function validateNote(note: unknown): string | null {
  if (note === undefined || note === null) {
    return null;
  }
  if (typeof note !== "string") {
    return "note must be a string";
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return `note must be at most ${MAX_NOTE_LENGTH} characters`;
  }
  return null;
}
