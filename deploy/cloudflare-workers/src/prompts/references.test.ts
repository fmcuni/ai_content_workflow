import { describe, expect, it } from "vitest";
import { referencesFor } from "./references";
import { WRITER_OUTPUT_SCHEMA, AUDIT_OUTPUT_SCHEMA, OUTLINE_SCHEMA } from "../agents/schemas";

const AGENT_TEMPLATE_IDS = [
  "gap_analysis",
  "outline_create_mode",
  "outline_rewrite_mode",
  "writer_create",
  "writer_full_rewrite",
  "writer_small_refresh",
  "audit",
  "topic_gen",
  "topic_dedup",
  "topic_hot",
  "topic_existing_search",
];

describe("referencesFor", () => {
  it("returns a user prompt reference for every agent template", () => {
    for (const id of AGENT_TEMPLATE_IDS) {
      expect(referencesFor(id).user_prompt_template, id).toBeTruthy();
    }
  });

  it("returns the real responseSchema constants", () => {
    expect(referencesFor("audit").response_json_schema).toBe(AUDIT_OUTPUT_SCHEMA);
    expect(referencesFor("writer_create").response_json_schema).toBe(WRITER_OUTPUT_SCHEMA);
    expect(referencesFor("writer_full_rewrite").response_json_schema).toBe(WRITER_OUTPUT_SCHEMA);
    expect(referencesFor("outline_create_mode").response_json_schema).toBe(OUTLINE_SCHEMA);
    expect(referencesFor("outline_rewrite_mode").response_json_schema).toBe(OUTLINE_SCHEMA);
  });

  it("topic_existing_search has a user prompt but no structured-output schema", () => {
    const refs = referencesFor("topic_existing_search");
    expect(refs.user_prompt_template).toBeTruthy();
    expect(refs.response_json_schema).toBeNull();
  });

  it("partials and unknown ids get null references", () => {
    for (const id of ["_writer_schema", "_writer_seo", "nope"]) {
      expect(referencesFor(id)).toEqual({
        user_prompt_template: null,
        response_json_schema: null,
      });
    }
  });

  it("all three writer templates share one user prompt shape", () => {
    const create = referencesFor("writer_create").user_prompt_template;
    expect(referencesFor("writer_full_rewrite").user_prompt_template).toBe(create);
    expect(referencesFor("writer_small_refresh").user_prompt_template).toBe(create);
  });
});
