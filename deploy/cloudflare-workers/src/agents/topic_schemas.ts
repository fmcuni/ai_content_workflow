/**
 * Gemini responseSchema constants for the topic-expansion agents, mirroring the
 * Python Pydantic models in content_tool/models/topic_batch.py
 * (TopicGenOutput / TopicDedupOutput / TopicHotOutput).
 *
 * These plain JSON-Schema objects are passed directly to the Gemini wrapper's
 * `responseSchema` option. Declared in the same `as const` literal style as
 * OUTLINE_SCHEMA in ./schemas.ts.
 */

// ---------------------------------------------------------------------------
// TypeScript result interfaces (for typing parsed Gemini responses downstream)
// ---------------------------------------------------------------------------

export interface TopicGenCandidate {
  topic: string;
  keywords: string[];
}

export interface TopicGenOutput {
  topics: TopicGenCandidate[];
}

export interface TopicDedupOutput {
  existing: "yes" | "no" | "not_sure";
  existing_note: string;
  existing_url: string;
}

export interface TopicHotOutput {
  hot_topic: "yes" | "no";
  hot_topic_note: string;
}

// ---------------------------------------------------------------------------
// JSON-Schema constants
// ---------------------------------------------------------------------------

export const TOPIC_GEN_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          keywords: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["topic", "keywords"],
      },
    },
  },
  required: ["topics"],
} as const;

export const TOPIC_DEDUP_SCHEMA = {
  type: "object",
  properties: {
    existing: {
      type: "string",
      enum: ["yes", "no", "not_sure"],
    },
    existing_note: { type: "string" },
    existing_url: { type: "string" },
  },
  required: ["existing", "existing_note", "existing_url"],
} as const;

export const TOPIC_HOT_SCHEMA = {
  type: "object",
  properties: {
    hot_topic: {
      type: "string",
      enum: ["yes", "no"],
    },
    hot_topic_note: { type: "string" },
  },
  required: ["hot_topic", "hot_topic_note"],
} as const;
