import type { VoiceLocale } from "@/lib/types";

// Heuristic CJK detection: CJK Unified Ideographs + Compatibility Ideographs.
// Used only for advisory coherence warnings — never to block a save.
const CJK_RE = /[㐀-鿿豈-﫿]/;

function hasCjk(value: string | null | undefined): boolean {
  return Boolean(value) && CJK_RE.test(value as string);
}

// A value is "pure ASCII" if it is non-empty and contains no non-ASCII char.
function isPureAscii(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[\x00-\x7f]+$/.test(value);
}

/**
 * Non-blocking coherence check between `ui_lang` and the brand/heading strings.
 * Returns a list of advisory warning strings (empty = coherent). The caller
 * renders these in a banner; save is always allowed regardless.
 */
export function localeWarnings(locale: VoiceLocale): string[] {
  const warnings: string[] = [];
  // The heading/language fields the heuristic inspects. `sources_heading` is
  // only checked when non-empty (blank = follow the article's script).
  const checked: Array<[string, string | null]> = [
    ["output language", locale.output_language],
    ["FAQ heading", locale.faq_heading],
    ["sources heading", locale.sources_heading],
  ];

  if (locale.ui_lang === "en") {
    const cjkFields = checked
      .filter(([, v]) => hasCjk(v))
      .map(([label]) => label);
    if (cjkFields.length > 0) {
      warnings.push(
        `UI language is English but Chinese characters appear in: ${cjkFields.join(", ")}.`,
      );
    }
  } else if (locale.ui_lang === "zh-Hant") {
    const asciiFields = checked
      .filter(([, v]) => isPureAscii(v))
      .map(([label]) => label);
    if (asciiFields.length > 0) {
      warnings.push(
        `UI language is Traditional Chinese but these look pure-ASCII: ${asciiFields.join(", ")}.`,
      );
    }
  }

  return warnings;
}
