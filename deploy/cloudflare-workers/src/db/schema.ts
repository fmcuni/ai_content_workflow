// Row types for the `content_tool` schema, mapping Postgres columns → the
// shapes postgres.js returns. Conventions:
//   uuid/text/varchar → string; integer/numeric → number;
//   timestamptz/date → string (ISO, as postgres.js returns text by default);
//   boolean → boolean; jsonb → unknown (no obvious shape supplied).
// `| null` marks nullable columns.

export interface PersonaRow {
  persona_id: string;
  slug: string;
  name: string;
  voice_rules: unknown;
  banned_terms: unknown;
  required_phrasings: unknown;
  disclaimer_templates: unknown;
  tone_examples: unknown;
  glossary: unknown;
  locale: unknown;
  publish_target_id: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// content_tool.publish_targets — non-secret CMS target config. Credentials live
// in env under the auth_ref prefix ({auth_ref}_BASE_URL / _USERNAME /
// _APP_PASSWORD); never stored here.
export interface PublishTargetRow {
  publish_target_id: string;
  name: string;
  kind: string;
  auth_ref: string;
  status: string;
  is_archived: boolean;
}

export interface PromptTemplateRow {
  // Composite PK with template_id (migration 20260604172254). The reserved
  // sentinel '__shared__' holds the global judges + the canonical seed-of-record
  // that every voice falls back to for an uncustomised template.
  voice_slug: string;
  template_id: string;
  category: string;
  filename: string;
  body: string;
  sha256: string;
  bytes: number;
  updated_at: string;
  updated_by: string | null;
}

// Columns confirmed from supabase/migrations/20260528131043_baseline.sql
// (CREATE TABLE content_tool.prompt_versions). NOTE: the brief named the PK as
// `prompt_id`, but the migration's primary key is `version_id` — there is no
// `prompt_id` column. All fields below are confirmed against the baseline SQL.
export interface PromptVersionRow {
  version_id: string; // uuid, PRIMARY KEY
  voice_slug: string; // editing voice (migration 20260604172254)
  template_id: string;
  sha256: string;
  parent_sha256: string | null;
  body: string;
  bytes: number;
  saved_by: string;
  saved_at: string;
  kind: string; // default 'save'
  note: string | null; // optional human change reason (migration 20260610000000)
}

// content_tool.source_policy — per-voice editable source policy (one row per
// voice; PK voice_slug, migration 20260604172254 dropped the policy_id column).
// The reserved sentinel '__shared__' holds the seed-of-record. `body` is the
// canonical compact JSON of the policy.
export interface SourcePolicyRow {
  voice_slug: string; // PRIMARY KEY
  body: string;
  sha256: string;
  bytes: number;
  updated_at: string;
  updated_by: string | null;
}

// content_tool.source_policy_versions — append-only save/revert history. Scoped
// by voice_slug; policy_id is retained as a static history label ('default').
export interface SourcePolicyVersionRow {
  version_id: string; // uuid, PRIMARY KEY
  voice_slug: string;
  policy_id: string;
  sha256: string;
  parent_sha256: string | null;
  body: string;
  bytes: number;
  saved_by: string;
  saved_at: string;
  kind: string; // default 'save'
  note: string | null; // optional human change reason (migration 20260610000000)
}

export interface ArticleRow {
  article_id: string;
  article_url: string;
  wp_post_id: number | null;
  topic: string | null;
  persona: string | null;
  topic_category: string | null;
  first_seen_at: string;
  last_persisted_at: string | null;
  next_scan_due_at: string;
  dismissed_until: string | null;
  dismissed_by: string | null;
  dismissed_reason: string | null;
  updated_at: string;
}

export interface RefreshEvaluationRow {
  evaluation_id: string;
  article_id: string;
  evaluated_at: string;
  scanner_version: string;
  trigger_source: string;
  age_days: number;
  fetched_html_hash: string | null;
  deterministic_findings: unknown;
  llm_findings: unknown | null;
  llm_skipped_reason: string | null;
  staleness_score: number;
  recommended_action: string;
  outcome: string;
  resulting_run_id: string | null;
  outcome_set_at: string | null;
  outcome_set_by: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  est_cost_usd_cents: number | null;
  latency_ms: number | null;
}

// Subset of columns needed downstream.
export interface RunRow {
  run_id: string;
  created_at: string;
  status: string;
  article_id: string | null;
  mode: string;
  start_mode: string;
  persona: string;
  topic: string;
  iteration_count: number;
}

// Cost-relevant subset.
export interface DraftRow {
  draft_id: string;
  run_id: string;
  iteration: number;
  tokens_in: number | null;
  tokens_out: number | null;
  thinking_tokens: number | null;
}

// Cost-relevant subset.
export interface GapAnalysisRow {
  run_id: string;
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
  thinking_tokens: number | null;
}

export interface WpUserRow {
  id: number;
  name: string;
  slug: string;
  synced_at: string;
}

export interface WpCategoryRow {
  id: number;
  name: string;
  slug: string;
  synced_at: string;
}
