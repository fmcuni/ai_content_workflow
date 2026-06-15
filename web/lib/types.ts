// --- Identity + role (UI gating) ------------------------------------------
// Mirrors the Workers backend GET /me and admin user-management contract.
// See lib/roles.ts for the rank/capability model.

export type UserRole = "viewer" | "author" | "reviewer" | "admin";

export interface MeResponse {
  email: string;
  role: UserRole;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export type RunStatus =
  | "pending" | "fetching" | "strategy" | "hitl_1"
  | "production" | "hitl_2" | "publishing" | "revising"
  | "persisted" | "published" | "failed"
  | "cancelled" | "rejected" | "changes_requested";

export type Mode = "auto" | "small_refresh" | "full_rewrite";
export type Route = "small_refresh" | "full_rewrite";

export interface RunSummary {
  run_id: string;
  status: RunStatus;
  topic: string;
  article_url: string;
  mode: Mode;
  created_at: string;
  // Email (or `system:*`/`dev@local` sentinel) of whoever created the run —
  // bound to the authenticated session at creation. Surfaced in the ledger's
  // Created column, the "who created" filter, and the drawer brief.
  created_by?: string | null;
  chosen_route: Route | null;
  iteration_count: number;
  hitl_2_iteration?: number;
  start_mode?: StartMode;
  topic_candidate_id?: string | null;
  // Theme (topic_batch) this run was promoted from — topic_candidates.batch_id,
  // surfaced on the /runs list payload (both backends). NULL for standalone
  // (ad-hoc create / refresh) runs. Drives the runs board's theme→sub-task
  // grouping (see components/runs-ledger/board.ts).
  topic_batch_id?: string | null;
  target_audience?: string | null;
  keywords?: string[];
  persona?: string | null;
  acf_adv_id?: number | null;
  acf_widget_id?: number | null;
  edit_note?: string | null;
  // When true the run auto-approves the HITL_1 outline/gap-analysis gate and
  // proceeds straight to drafting. HITL_2 (draft → publish) still waits.
  auto_accept_hitl1?: boolean;
  // WordPress publish status + the operator's last-selected metadata. Surfaced
  // so the edit page can re-hydrate author / categories for create AND refresh
  // runs (a create run has no upstream post to read them back from).
  wp_publish_status?: "draft" | "future" | "publish" | null;
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  // Scheduled/recorded publish datetime (exists on the run row; the Ledger's
  // Post-date column reads it, falling back to "—" when the list omits it).
  wp_publish_at?: string | null;
  wp_pushed_post_id?: number | null;
  // Latest render's SEO title + meta description (LEFT JOIN LATERAL renders⟕drafts
  // by run_id, newest first — see GET /runs list-payload delta, both backends).
  // Drives the ledger's draft-snippet line + the drawer's SERP preview/prefill;
  // null when the run has no render yet.
  seo_title?: string | null;
  meta_description?: string | null;
  error?: { type: string; message: string } | null;
}

export type StartMode = "refresh" | "create";

export interface CreateRunRequest {
  article_url?: string | null;
  topic: string;
  keywords: string[];
  mode: Mode;
  edit_note?: string | null;
  acf_adv_id: number;
  acf_widget_id: number;
  persona: string;
  topic_category?: string | null;
  editor_email: string;
  triggered_by_evaluation_id?: string | null;
  start_mode?: StartMode;
  topic_candidate_id?: string | null;
  target_audience?: string | null;
  // Auto-approve the HITL_1 outline gate on this run (see RunSummary).
  auto_accept_hitl1?: boolean;
}

export type BatchStatus =
  | "pending"
  | "generating"
  | "analysing"
  | "ready_for_review"
  | "partially_promoted"
  | "done"
  | "failed";

export type CandidateStatus = "candidate" | "promoted" | "skipped" | "errored";

export type ExistingVerdict = "yes" | "no" | "not_sure";
export type HotTopicVerdict = "yes" | "no";

/**
 * Dedup stage-1 (topic_existing_search) diagnostics — mirrors the backend
 * Stage1Diagnostics. Explains why `existing` was decided, especially empty
 * "no" verdicts: a high `resolve_failures` with no `bowtie_hits` means the
 * search hit transient failures rather than genuinely finding no article.
 */
export interface Stage1Diagnostics {
  grounding_chunks: number;
  resolve_attempts: number;
  resolved_count: number;
  bowtie_hits: number;
  filtered_out: number;
  resolve_failures: number;
  attempt_cap_hit: boolean;
  grounding_empty: boolean;
  second_pass: boolean;
}

export interface TopicCandidate {
  candidate_id: string;
  batch_id: string;
  position: number;
  status: CandidateStatus;
  topic: string;
  keywords: string[];
  original_topic: string;
  original_keywords: string[];
  existing: ExistingVerdict | null;
  existing_note: string | null;
  existing_url: string | null;
  hot_topic: HotTopicVerdict | null;
  hot_topic_note: string | null;
  existing_search_debug: Stage1Diagnostics | null;
  persona_slug: string | null;
  acf_adv_id: number | null;
  acf_widget_id: number | null;
  operator_note: string | null;
  promote_mode: "create" | "refresh" | null;
  promoted_run_id: string | null;
  last_error: string | null;
  last_edited_by: string | null;
  last_edited_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TopicBatch {
  batch_id: string;
  status: BatchStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  research_theme: string;
  target_audience: string;
  topic_count: number;
  keywords_per_topic: number;
  must_cover: string[];
  must_avoid: string[];
  priority_focus: string | null;
  notes: string | null;
  persona_default: string | null;
  acf_adv_id_default: number | null;
  acf_widget_id_default: number | null;
  // Default carried to every run promoted from this batch: when true those runs
  // auto-approve their HITL_1 outline gate.
  auto_accept_hitl1_default?: boolean;
  cost_cents: number;
  last_error: string | null;
  candidates?: TopicCandidate[] | null;
}

export interface TopicBatchIn {
  research_theme: string;
  target_audience: string;
  topic_count: number;
  keywords_per_topic: number;
  must_cover: string[];
  must_avoid: string[];
  priority_focus?: string | null;
  notes?: string | null;
  persona_default?: string | null;
  acf_adv_id_default?: number | null;
  acf_widget_id_default?: number | null;
  auto_accept_hitl1_default?: boolean;
  editor_email: string;
}

export interface TopicBatchCreateResponse {
  batch_id: string;
  status: BatchStatus;
}

export interface PatchCandidateIn {
  topic?: string;
  keywords?: string[];
  persona_slug?: string;
  acf_adv_id?: number;
  acf_widget_id?: number;
  operator_note?: string;
  editor_email: string;
}

export interface PromotionItem {
  candidate_id: string;
  mode: "create" | "refresh";
}

export interface PromoteRequest {
  promotions: PromotionItem[];
  editor_email: string;
}

export interface PromoteResponseItem {
  candidate_id: string;
  run_id: string;
  mode: "create" | "refresh";
}

export interface PromoteResponse {
  items: PromoteResponseItem[];
  batch_status: BatchStatus;
}

export interface GapAnalysis {
  target_query: string;
  top_pages: { url: string; title: string; rank: number }[];
  current_article_assessment: {
    strengths: string[];
    outdated_points: string[];
    weak_sections: string[];
    structure_status: "still_competitive" | "partly_outdated" | "outdated";
  };
  content_gaps: {
    missing_topics: string[];
    missing_intents: string[];
    freshness_gaps: string[];
    semantic_gaps: string[];
    source_trust_gaps: string[];
    ai_extractability_gaps: string[];
    hk_localization_gaps: string[];
    faq_gaps: string[];
  };
  recommended_outline: string;
  update_plan: {
    must_add: string[]; must_update: string[]; must_remove: string[];
    must_reorder: string[]; faq_to_add: string[]; facts_to_verify: string[];
  };
  chosen_route: Route;
  route_reason: string;
}

export interface OutlineSection {
  heading_level: 2 | 3;
  heading_text: string;
  action: "keep" | "update" | "add" | "remove" | "reorder";
  intent: string;
  key_points: string[];
  format_hint: "paragraph" | "bullet" | "numbered" | "table";
  source_note: string | null;
}

export interface Outline {
  h1: string;
  meta_description_hint: string;
  sections: OutlineSection[];
  faq_section: { question: string; answer_intent: string; action: "keep" | "update" | "add" | "remove" }[];
  shortcode_positions: { adv_panel_after_section_index: number; page_widget_before: "faq" };
}

export interface Render {
  seo_title: string;
  meta_description: string;
  html_body: string;
  faq_schema_jsonld: Record<string, unknown> | null;
  excerpt_suggestion: string;
  slug_suggestion: string;
  // Optimistic-concurrency token (latest render). Echoed back as
  // `expected_version` on PUT /article and PATCH /runs/{id} so a stale edit
  // is rejected (409 stale_version) instead of clobbering.
  version?: number;
}

/**
 * Partial update of a run's editable destination / brief fields, sent by the
 * Ledger board's inline cell editors via PATCH /runs/{id}. Only provided
 * (non-null) fields are overwritten. Persona/Voice is intentionally absent —
 * it is read-only in the board. `expected_version` (the latest render's
 * version) opts into optimistic concurrency; omit for last-write-wins.
 */
export interface RunWpMetaPatch {
  acf_adv_id?: number | null;
  acf_widget_id?: number | null;
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_slug?: string | null;
  wp_publish_status?: "draft" | "future" | "publish" | null;
  wp_publish_at?: string | null;
  expected_version?: number | null;
}

/**
 * Partial update of a topic batch's promotion defaults, sent by the Ledger
 * band's inline default editors via PATCH /topic-batches/{id}. Only fields
 * present are applied; a default only affects runs promoted AFTER the change.
 */
export interface TopicBatchDefaultsPatch {
  persona_default?: string | null;
  acf_adv_id_default?: number | null;
  acf_widget_id_default?: number | null;
  auto_accept_hitl1_default?: boolean | null;
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

export interface Audit {
  overall_pass: boolean;
  severity_high: number;
  severity_medium: number;
  severity_low: number;
  llm_findings: { findings: AuditFinding[] };
  deterministic_findings: { findings: AuditFinding[] };
}

// Token usage + estimated spend for a single run, priced by the model the run
// actually used. Shape mirrors GET /costs/run/{id} on both backends
// (content_tool/api/routes/costs.py + deploy/cloudflare-workers/src/routes/costs.ts):
// integer token counts and truncated integer cents. The endpoint 404s for runs
// with no usage yet (no gap-analysis row and no drafts).
export interface RunCost {
  tokens_in: number;
  tokens_out: number;
  thinking_tokens: number;
  est_usd_cents: number;
}

export interface SseEvent {
  event: string;
  run_id: string;
  iteration?: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

// A single persisted per-step event log row. One shape serves both runs and
// topic batches via `stream_kind`. Returned by GET /runs/{id}/logs and
// GET /topic-batches/{id}/logs, ordered by `seq` ASC.
export type RunEventLogLevel = "info" | "thinking" | "gate" | "error";

export interface RunEventLog {
  log_id: string;
  stream_id: string;
  stream_kind: "run" | "batch";
  seq: number;
  event: string;
  level: RunEventLogLevel;
  step: string | null;
  iteration: number | null;
  duration_ms: number | null;
  payload: Record<string, unknown>;
  recorded_at: string;
}

export interface Hitl2Comment {
  id: string;
  anchor_text: string;
  body: string;
}

/**
 * Review threads — human-only highlight discussions (comment / reply / resolve).
 * A SEPARATE pipeline from the AI-edit `Hitl2Comment`: review threads are never
 * dispatched to apply-edits. Persisted in the `review_threads` table.
 */
export interface ReviewMessage {
  id: string;
  author_email: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface ReviewThread {
  thread_id: string;
  run_id: string;
  anchor_id: string;
  anchor_text: string | null;
  status: "open" | "resolved";
  messages: ReviewMessage[];
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  updated_at: string;
}

export interface CreateReviewThreadIn {
  anchor_id: string;
  anchor_text?: string | null;
  body: string;
  editor_email?: string | null;
  editor_name?: string | null;
}

export interface DryPublishRequest {
  edited_html_body?: string | null;
  edited_seo_title?: string | null;
  edited_meta_description?: string | null;
  wp_publish_status?: "draft" | "future" | "publish" | null;
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  wp_publish_at?: string | null;
}

export interface DryPublishResponse {
  target_base_url: string;
  target_label: string;
  request_method: "PUT" | "POST";
  request_url: string;
  request_headers: Record<string, string>;
  request_body: Record<string, unknown>;
}

export interface Hitl2Request {
  decision: "approve" | "request_changes" | "reject";
  /** Authenticated approver identity (email) for the audit trail. The Workers
   * backend overrides this from the session; the Python sidecar uses it. */
  editor_email?: string;
  notes?: string | null;
  comments?: Hitl2Comment[] | null;
  edited_html_body?: string | null;
  edited_seo_title?: string | null;
  edited_meta_description?: string | null;
  wp_publish_status: "draft" | "future" | "publish";
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  wp_publish_at?: string | null;
}

/**
 * Inline AI edit of an article. The agent revises `html_body` per the anchored
 * `comments` and/or overall `notes` and returns the revised HTML — no pipeline
 * re-run, no graph resume. Per-comment apply sends a single comment; the overall
 * "Notes to AI" apply sends `notes` only.
 */
export interface ApplyEditsRequest {
  html_body: string;
  comments?: Hitl2Comment[] | null;
  notes?: string | null;
}

export interface ApplyEditsResponse {
  html_body: string;
}

export type Hitl2SnapshotTrigger =
  | "interval"
  | "navigate"
  | "unload"
  | "manual"
  | "generated";

export interface Hitl2SnapshotIn {
  trigger: Hitl2SnapshotTrigger;
  /** Snapshot author identity (email). See Hitl2Request.editor_email. */
  editor_email?: string;
  html_body: string;
  /** Tracked-changes baseline (last committed body). null/undefined ⇒ no pending. */
  committed_html_body?: string | null;
  seo_title?: string | null;
  meta_description?: string | null;
  notes?: string | null;
  comments?: Hitl2Comment[] | null;
  wp_publish_status?: string | null;
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  wp_publish_at?: string | null;
}

export interface Hitl2Snapshot extends Hitl2SnapshotIn {
  snapshot_id: string;
  created_at: string;
  created_by: string | null;
  /** Stable display number (oldest = 1); null on the single-row POST response. */
  version_number?: number | null;
  /** True for the snapshot whose body matches the live render. */
  is_current?: boolean;
}

// One draft iteration that produced a render, for the unified run-history
// timeline. Mirrors GET /runs/{id}/drafts on both backends (newest-first by
// iteration). Carries the render body + SEO metadata so a draft is restorable.
export interface RunDraft {
  draft_id: string;
  iteration: number;
  created_at: string;
  html_body: string;
  seo_title: string;
  meta_description: string;
}

export interface ArticleEditRequest {
  html_body: string;
  seo_title: string;
  meta_description: string;
  wp_publish_status?: "draft" | "future" | "publish" | null;
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  wp_publish_at?: string | null;
}

export interface RepublishResponse {
  wp_post_id: number;
  link: string | null;
  status: string;
}

export type RecommendedAction = "refresh" | "monitor" | "ok";
export type EvaluationOutcome = "open" | "triggered" | "dismissed" | "superseded";

export interface RefreshEvaluation {
  evaluation_id: string;
  evaluated_at: string;
  age_days: number;
  staleness_score: string;
  recommended_action: RecommendedAction;
  deterministic_findings: {
    findings: Array<{ id: string; severity: "high" | "medium" | "low"; message: string; context?: Record<string, unknown> }>;
    severity_high: number;
    severity_medium: number;
    severity_low: number;
    passed: boolean;
  };
  llm_findings: Record<string, unknown> | null;
  llm_skipped_reason: string | null;
  outcome: EvaluationOutcome;
  resulting_run_id: string | null;
}

export interface Article {
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
  latest_evaluation: RefreshEvaluation | null;
  open_runs_count: number;
}

export interface ArticleListResponse {
  items: Article[];
  total: number;
}

export interface ArticleDetail extends Article {
  recent_evaluations: RefreshEvaluation[];
  recent_run_ids: string[];
}

export interface ScanResponse {
  tick_id: string;
  scanned: number;
  evaluations_created: number;
  llm_calls: number;
  est_cost_usd_cents: number;
  started_at: string;
  finished_at: string;
  skipped: Array<{ article_id?: string; reason: string }>;
}

export interface WpUserOption { id: number; name: string; slug: string }
export interface WpCategoryOption { id: number; name: string; slug: string }

export interface ExistingPost {
  wp_post_id: number;
  link: string | null;
  wp_author_id: number | null;
  wp_author_name: string | null;
  wp_category_id: number | null;
  wp_category_name: string | null;
  wp_slug: string | null;
}

export type GlossaryStatus = "preferred" | "avoid" | "forbidden" | "do_not_translate";

export interface GlossaryEntry {
  term: string;
  preferred: string;
  variants: string[];
  status: GlossaryStatus;
  notes: string | null;
}

export interface DisclaimerTemplate {
  condition: string;
  disclaimer: string;
}

// Per-voice locale & brand. Wire casing is snake_case (matches the personas
// endpoint + the preview override body). HK-ZH defaults are what an admin sees
// as placeholders; `sources_heading` null = follow the article's script
// (auto-detected) rather than a fixed string. The persona-block label set
// (Chinese vs English scaffolding) is auto-derived from `output_language` at
// render time, so there is no manual UI-language field.
export interface VoiceLocale {
  output_language: string;
  brand_name: string;
  market: string;
  sources_heading: string | null;
  faq_heading: string;
}

export interface Persona {
  persona_id: string;
  slug: string;
  name: string;
  voice_rules: string[];
  banned_terms: string[];
  required_phrasings: string[];
  disclaimer_templates: Record<string, DisclaimerTemplate>;
  tone_examples: Record<string, string[]>;
  glossary: GlossaryEntry[];
  locale: VoiceLocale;
  publish_target_id: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// A CMS publish destination. Non-secret config only; credentials live in env
// under the auth_ref prefix on the backend.
export interface PublishTarget {
  publish_target_id: string;
  name: string;
  kind: string;
  auth_ref: string;
  status: string;
  is_archived: boolean;
}

// Create a WordPress target. kind is always 'wordpress' this phase (not sent).
export interface PublishTargetCreate {
  name: string;
  auth_ref: string;
  status?: "active" | "inactive";
}

// Edit a target's display name / status. auth_ref + kind are immutable.
export interface PublishTargetUpdate {
  name?: string;
  status?: "active" | "inactive";
}

export interface PublishTargetUsage {
  publish_target_id: string;
  assigned_voice_count: number;
}

// Presence-only check of a target's credential env vars (booleans only).
export interface PublishTargetReadiness {
  publish_target_id: string;
  auth_ref: string;
  base_url: boolean;
  username: boolean;
  app_password: boolean;
  ready: boolean;
}

export interface PersonaIn {
  slug: string;
  name: string;
  voice_rules: string[];
  banned_terms: string[];
  required_phrasings: string[];
  disclaimer_templates: Record<string, DisclaimerTemplate>;
  tone_examples: Record<string, string[]>;
  glossary?: GlossaryEntry[];
  locale?: VoiceLocale;
}

export interface PersonaPatch {
  name?: string;
  voice_rules?: string[];
  banned_terms?: string[];
  required_phrasings?: string[];
  disclaimer_templates?: Record<string, DisclaimerTemplate>;
  tone_examples?: Record<string, string[]>;
  glossary?: GlossaryEntry[];
  // Whole-object replace: the form always sends all 6 fields. Omitting `locale`
  // leaves the stored column untouched server-side.
  locale?: VoiceLocale;
  // null clears the assignment (→ backend legacy WP default).
  publish_target_id?: string | null;
}

export interface PersonaUsage {
  slug: string;
  by_status: Record<string, number>;
  total: number;
}

export type PromptKind = "llm" | "deterministic";

export type GraphMode = "refresh" | "create" | "topic_expansion";

export interface PromptNode {
  id: string;
  // strategy | production | publish for run pipelines; generate | analyse for
  // the topic-expansion subgraph.
  sub_graph: string;
  order: number;
  kind: PromptKind;
  uses_persona: boolean;
  system_prompt_template_id: string | null;
  alt_template_ids?: string[];
  description: string;
}

export interface PromptEdge { from: string; to: string; label?: string }
export interface PromptGate {
  id: string;
  // Node id the gate sits before, or "__end__" for a review that follows the
  // whole subgraph (e.g. HITL_T1).
  before: string;
  label: string;
  description: string;
}

export interface PromptGraph {
  mode?: GraphMode;
  label?: string;
  summary?: string;
  nodes: PromptNode[];
  edges: PromptEdge[];
  gates: PromptGate[];
}

export interface PromptTemplate {
  template_id: string;
  template: string;
  filename?: string;
  category?: PromptTemplateCategory;
  sha256?: string;
  // Echoed by the per-voice detail route: `voice` is the requested voice;
  // `voice_slug` is the voice that owns the resolved row (selected vs shared).
  voice?: string;
  voice_slug?: string;
}

export type PromptTemplateCategory = "agent" | "partial";

export interface PromptTemplateListItem {
  template_id: string;
  filename: string;
  category: PromptTemplateCategory;
  sha256: string;
  bytes: number;
  // The voice that owns the resolved row: the selected voice when it has
  // customised the template, or "__shared__" when the row is the shared
  // fallback the voice inherits.
  voice_slug: string;
}

// Judges are global and read-only — they always resolve under "__shared__".
export interface JudgeTemplateListItem {
  template_id: string;
  filename: string;
  category: "judge";
  sha256: string;
  bytes: number;
  voice_slug: string;
  read_only: true;
}

export interface PromptTemplateListResponse {
  voice: string;
  templates: PromptTemplateListItem[];
  judges: JudgeTemplateListItem[];
}

export interface PromptTemplateSchema {
  template_id: string;
  voice?: string;
  required_placeholders: string[];
  found_placeholders: string[];
  found_includes: string[];
  unknown_includes: string[];
  /** Reference shape of the user prompt sent alongside this system prompt (null for partials). */
  user_prompt_template?: string | null;
  /** The voice's stored locale — the values the assembled prompt's
   * {brand_name}/{output_language}/{market}/… tokens resolve to at runtime. */
  voice_locale?: VoiceLocale | null;
  /** The Gemini responseSchema this agent is called with (null when the agent returns plain text). */
  response_json_schema?: Record<string, unknown> | null;
}

export interface PromptTemplateConsumers {
  template_id: string;
  voice?: string;
  consumers: string[];
}

export interface PromptSaveResponse {
  template_id: string;
  voice?: string;
  sha256: string;
  bytes: number;
  version_id?: string;
  saved_at?: string;
  saved_by?: string;
}

export interface PromptPreviewResponse {
  resolved: string;
  route: string;
  voice?: string;
}

export type PromptVersionKind = "save" | "revert" | "seed";

export interface PromptVersionSummary {
  version_id: string;
  /** Stable display number, oldest = 1. */
  version_number: number;
  /** True for the entry whose body matches the live (current) template. */
  is_current: boolean;
  sha256: string;
  parent_sha256: string | null;
  bytes: number;
  saved_by: string;
  saved_at: string;
  kind: PromptVersionKind;
  /** Optional human-supplied change reason (null for autosaves/seed/revert). */
  note: string | null;
}

export interface PromptVersionDetail extends PromptVersionSummary {
  template_id: string;
  body: string;
}

export interface PromptVersionsResponse {
  template_id: string;
  voice?: string;
  /** sha of the live body the editor is showing (matches the is_current row). */
  current_sha256?: string | null;
  versions: PromptVersionSummary[];
}

export interface PromptRevertResponse extends PromptSaveResponse {
  reverted_from_version_id: string;
}

export interface UserPromptExample {
  run_id: string;
  agent: string;
  prompt: string;
}

// --- Source policy (editable) ---------------------------------------------

export interface SourcePolicyDoc {
  deny: { domains: string[]; tlds: string[] };
  prefer: { tlds: string[]; domains: string[] };
  community_exception: { topic_categories: string[]; allowed_domains: string[] };
  /** Optional editable prompt-block template. When set, it overrides the
   * default rendered block; tokens like {prefer_tlds} / {denied_tlds_line} are
   * filled server-side from the lists above. Absent/empty ⇒ default block. */
  prompt_block?: string;
}

// Per-voice as of the per-voice-prompt-library migration: `policy_id` is gone,
// replaced by `voice` (the requested voice) + `voice_slug` (the voice that owns
// the resolved row — selected voice, "__shared__" seed, or YAML fallback).
export interface SourcePolicyResponse {
  voice: string;
  voice_slug: string;
  policy: SourcePolicyDoc;
  sha256: string;
  bytes: number;
  rendered: string;
}

export interface SourcePolicyPreviewResponse {
  policy: SourcePolicyDoc;
  rendered: string;
}

// Save/revert echo the requested `voice` (not `voice_slug` — the row now exists
// for that voice) plus the new version metadata.
export interface SourcePolicySaveResponse {
  voice: string;
  policy: SourcePolicyDoc;
  sha256: string;
  bytes: number;
  rendered: string;
  version_id: string;
  saved_at: string;
  saved_by: string;
}

export interface SourcePolicyVersionsResponse {
  voice: string;
  /** sha of the live policy the editor is showing (matches the is_current row). */
  current_sha256?: string | null;
  versions: PromptVersionSummary[];
}

export interface SourcePolicyVersionDetail extends PromptVersionSummary {
  voice: string;
  policy_id: string;
  policy: SourcePolicyDoc;
  rendered: string;
}

export interface SourcePolicyRevertResponse extends SourcePolicySaveResponse {
  reverted_from_version_id: string;
}

// --- Desktop first-run setup (mirrors content_tool/api/routes/setup.py) ---

export interface SetupStatus {
  configured: boolean;
  missing: string[];
  wp_configured: boolean;
}

export interface SetupVerifyResult {
  postgres: boolean;
  gemini: boolean;
}

export interface SetupRequest {
  gemini_api_key: string;
  postgres_url: string;
  wp_base_url?: string;
  wp_target?: "staging" | "production";
  wp_username?: string;
  wp_app_password?: string;
}

export type SetupConfigureResult =
  | { ok: true }
  | { ok: false; reason: "verification_failed"; checks: SetupVerifyResult };
