// Gemini pricing — USD per 1M tokens. Ported verbatim from config/pricing.yaml
// (the hot-reloaded source of truth in the Python backend). Update when Google
// changes pricing. Source: https://ai.google.dev/pricing
//
// NOTE: thinking tokens are billed at the OUTPUT rate (see the yaml comment).
// This typed constant also seeds Phase 2's config work — keep it the single
// source of truth for model rates on the Workers side.

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  input_per_million_usd: number;
  /** USD per 1,000,000 output tokens. */
  output_per_million_usd: number;
  /** USD per 1,000,000 thinking tokens (billed at the output rate). */
  thinking_per_million_usd: number;
}

export type PricingTable = Readonly<Record<string, ModelPricing>>;

export const PRICING: PricingTable = {
  "gemini-3.5-flash": {
    input_per_million_usd: 0.3,
    output_per_million_usd: 2.5,
    thinking_per_million_usd: 2.5,
  },
} as const;
