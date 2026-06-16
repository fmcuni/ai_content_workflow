"use client";

import type { VoiceLocale } from "@/lib/types";

// HK-ZH defaults — shown as input placeholders so an admin sees what "leave
// blank" yields. `sources_heading` default is null (follow the article script).
export const HK_ZH_LOCALE: VoiceLocale = {
  output_language: "香港繁體中文",
  brand_name: "Bowtie",
  market: "Google 香港繁中",
  sources_heading: null,
  faq_heading: "常見問題",
};

/** Hold `sources_heading` as null when blank, matching a freshly-loaded
 * baseline (the server stores null = "follow the article script"). */
export function normalizeLocale(next: VoiceLocale): VoiceLocale {
  return {
    ...next,
    sources_heading:
      next.sources_heading && next.sources_heading.trim() !== ""
        ? next.sources_heading
        : null,
  };
}

interface LocaleFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}

/** Single underline-style locale input. Shared primitive — used by the voice
 * compose drawer and the Voice Studio inspector. */
export function LocaleField({ label, value, placeholder, onChange }: LocaleFieldProps) {
  return (
    <div>
      <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1">{label}</p>
      <input
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
      />
    </div>
  );
}

interface LocaleFieldsProps {
  locale: VoiceLocale;
  /** Placeholder defaults (what an empty field falls back to server-side). */
  defaults?: VoiceLocale;
  onChange: (next: VoiceLocale) => void;
}

/** The five VoiceLocale fields as one group. Emits a normalized locale so
 * callers never have to re-handle the blank → null `sources_heading` rule. */
export function LocaleFields({ locale, defaults = HK_ZH_LOCALE, onChange }: LocaleFieldsProps) {
  const set = (patch: Partial<VoiceLocale>) => onChange(normalizeLocale({ ...locale, ...patch }));
  return (
    <div className="space-y-3">
      <LocaleField
        label="Output language · 輸出語言"
        value={locale.output_language}
        placeholder={defaults.output_language}
        onChange={(v) => set({ output_language: v })}
      />
      <LocaleField
        label="Brand name · 品牌名稱"
        value={locale.brand_name}
        placeholder={defaults.brand_name}
        onChange={(v) => set({ brand_name: v })}
      />
      <LocaleField
        label="Market · 市場"
        value={locale.market}
        placeholder={defaults.market}
        onChange={(v) => set({ market: v })}
      />
      <LocaleField
        label="Sources heading · 資訊來源標題"
        value={locale.sources_heading ?? ""}
        placeholder="(blank → follow article script)"
        onChange={(v) => set({ sources_heading: v })}
      />
      <LocaleField
        label="FAQ heading · 常見問題標題"
        value={locale.faq_heading}
        placeholder={defaults.faq_heading}
        onChange={(v) => set({ faq_heading: v })}
      />
    </div>
  );
}
