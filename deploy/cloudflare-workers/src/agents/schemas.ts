/**
 * Gemini responseSchema constants mirroring the Python Pydantic models in
 * content_tool/models/outline.py, writer.py, and audit.py.
 *
 * These plain JSON-Schema objects are passed directly to the Gemini wrapper's
 * `responseSchema` option. The wrapper strips `propertyOrdering` before
 * forwarding to the API, so that field is omitted here.
 */

// ---------------------------------------------------------------------------
// TypeScript interfaces (for typing parsed Gemini responses downstream)
// ---------------------------------------------------------------------------

export interface OutlineSection {
  heading_level: 2 | 3;
  heading_text: string;
  action: "keep" | "update" | "add" | "remove" | "reorder";
  intent: string;
  key_points: string[];
  format_hint: "paragraph" | "bullet" | "numbered" | "table";
  source_note: string | null;
}

export interface FaqItem {
  question: string;
  answer_intent: string;
  action: "keep" | "update" | "add" | "remove";
}

export interface ShortcodePositions {
  adv_panel_after_section_index: number;
  page_widget_before: "faq";
}

export interface Outline {
  h1: string;
  meta_description_hint: string;
  sections: OutlineSection[];
  faq_section: FaqItem[];
  shortcode_positions: ShortcodePositions;
}

export interface CitationIntent {
  claim: string;
  why_cited: string;
}

export interface WriterOutput {
  diagnose: string;
  markup: string;
  citation_intents: CitationIntent[];
}

export interface AuditFinding {
  id: string;
  category: "format" | "compliance" | "voice" | "coverage" | "safety" | "citation";
  severity: "high" | "medium" | "low";
  location: string;
  issue: string;
  suggested_fix: string;
  must_fix: boolean;
}

export interface SeveritySummary {
  high: number;
  medium: number;
  low: number;
}

export interface AuditOutput {
  overall_pass: boolean;
  severity_summary: SeveritySummary;
  findings: AuditFinding[];
}

export interface TopPage {
  url: string;
  title: string;
  rank: number;
}

export interface CurrentArticleAssessment {
  strengths: string[];
  outdated_points: string[];
  weak_sections: string[];
  structure_status: "still_competitive" | "partly_outdated" | "outdated";
}

export interface ContentGaps {
  missing_topics: string[];
  missing_intents: string[];
  freshness_gaps: string[];
  semantic_gaps: string[];
  source_trust_gaps: string[];
  ai_extractability_gaps: string[];
  hk_localization_gaps: string[];
  faq_gaps: string[];
}

export interface UpdatePlan {
  must_add: string[];
  must_update: string[];
  must_remove: string[];
  must_reorder: string[];
  faq_to_add: string[];
  facts_to_verify: string[];
}

export interface GapAnalysis {
  target_query: string;
  top_pages: TopPage[];
  current_article_assessment: CurrentArticleAssessment;
  content_gaps: ContentGaps;
  recommended_outline: string;
  update_plan: UpdatePlan;
  chosen_route: "small_refresh" | "full_rewrite";
  route_reason: string;
}

// ---------------------------------------------------------------------------
// JSON-Schema constants
// ---------------------------------------------------------------------------

export const OUTLINE_SCHEMA = {
  type: "object",
  properties: {
    h1: { type: "string" },
    meta_description_hint: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading_level: { type: "integer", enum: [2, 3] },
          heading_text: { type: "string" },
          action: {
            type: "string",
            enum: ["keep", "update", "add", "remove", "reorder"],
          },
          intent: { type: "string" },
          key_points: {
            type: "array",
            items: { type: "string" },
          },
          format_hint: {
            type: "string",
            enum: ["paragraph", "bullet", "numbered", "table"],
          },
          source_note: { type: ["string", "null"] },
        },
        required: [
          "heading_level",
          "heading_text",
          "action",
          "intent",
          "key_points",
          "format_hint",
        ],
      },
    },
    faq_section: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          answer_intent: { type: "string" },
          action: {
            type: "string",
            enum: ["keep", "update", "add", "remove"],
          },
        },
        required: ["question", "answer_intent", "action"],
      },
    },
    shortcode_positions: {
      type: "object",
      properties: {
        adv_panel_after_section_index: { type: "integer", minimum: 0 },
        page_widget_before: { type: "string", enum: ["faq"] },
      },
      required: ["adv_panel_after_section_index", "page_widget_before"],
    },
  },
  required: [
    "h1",
    "meta_description_hint",
    "sections",
    "faq_section",
    "shortcode_positions",
  ],
} as const;

export const WRITER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    diagnose: { type: "string" },
    markup: { type: "string" },
    citation_intents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          why_cited: { type: "string" },
        },
        required: ["claim", "why_cited"],
      },
    },
  },
  required: ["diagnose", "markup", "citation_intents"],
} as const;

export const AUDIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    overall_pass: { type: "boolean" },
    severity_summary: {
      type: "object",
      properties: {
        high: { type: "integer" },
        medium: { type: "integer" },
        low: { type: "integer" },
      },
      required: ["high", "medium", "low"],
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: {
            type: "string",
            enum: ["format", "compliance", "voice", "coverage", "safety", "citation"],
          },
          severity: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          location: { type: "string" },
          issue: { type: "string" },
          suggested_fix: { type: "string" },
          must_fix: { type: "boolean" },
        },
        required: [
          "id",
          "category",
          "severity",
          "location",
          "issue",
          "suggested_fix",
          "must_fix",
        ],
      },
    },
  },
  required: ["overall_pass", "severity_summary", "findings"],
} as const;

export const GAP_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    target_query: { type: "string" },
    top_pages: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          rank: { type: "integer" },
        },
        required: ["url", "title", "rank"],
      },
    },
    current_article_assessment: {
      type: "object",
      properties: {
        strengths: { type: "array", items: { type: "string" } },
        outdated_points: { type: "array", items: { type: "string" } },
        weak_sections: { type: "array", items: { type: "string" } },
        structure_status: {
          type: "string",
          enum: ["still_competitive", "partly_outdated", "outdated"],
        },
      },
      required: ["strengths", "outdated_points", "weak_sections", "structure_status"],
    },
    content_gaps: {
      type: "object",
      properties: {
        missing_topics: { type: "array", items: { type: "string" } },
        missing_intents: { type: "array", items: { type: "string" } },
        freshness_gaps: { type: "array", items: { type: "string" } },
        semantic_gaps: { type: "array", items: { type: "string" } },
        source_trust_gaps: { type: "array", items: { type: "string" } },
        ai_extractability_gaps: { type: "array", items: { type: "string" } },
        hk_localization_gaps: { type: "array", items: { type: "string" } },
        faq_gaps: { type: "array", items: { type: "string" } },
      },
      required: [
        "missing_topics",
        "missing_intents",
        "freshness_gaps",
        "semantic_gaps",
        "source_trust_gaps",
        "ai_extractability_gaps",
        "hk_localization_gaps",
        "faq_gaps",
      ],
    },
    recommended_outline: { type: "string" },
    update_plan: {
      type: "object",
      properties: {
        must_add: { type: "array", items: { type: "string" } },
        must_update: { type: "array", items: { type: "string" } },
        must_remove: { type: "array", items: { type: "string" } },
        must_reorder: { type: "array", items: { type: "string" } },
        faq_to_add: { type: "array", items: { type: "string" } },
        facts_to_verify: { type: "array", items: { type: "string" } },
      },
      required: [
        "must_add",
        "must_update",
        "must_remove",
        "must_reorder",
        "faq_to_add",
        "facts_to_verify",
      ],
    },
    chosen_route: {
      type: "string",
      enum: ["small_refresh", "full_rewrite"],
    },
    route_reason: { type: "string" },
  },
  required: [
    "target_query",
    "top_pages",
    "current_article_assessment",
    "content_gaps",
    "recommended_outline",
    "update_plan",
    "chosen_route",
    "route_reason",
  ],
} as const;
