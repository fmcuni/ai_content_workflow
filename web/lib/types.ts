export type RunStatus =
  | "pending" | "fetching" | "strategy" | "hitl_1"
  | "production" | "hitl_2" | "persisted" | "published" | "failed"
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
  chosen_route: Route | null;
  iteration_count: number;
  hitl_2_iteration?: number;
  start_mode?: StartMode;
  topic_candidate_id?: string | null;
  target_audience?: string | null;
  keywords?: string[];
  persona?: string | null;
  acf_adv_id?: number | null;
  acf_widget_id?: number | null;
  edit_note?: string | null;
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
  wp_pushed_post_id?: number | null;
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

export interface SseEvent {
  event: string;
  run_id: string;
  iteration?: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface Hitl2Comment {
  id: string;
  anchor_text: string;
  body: string;
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

export type Hitl2SnapshotTrigger = "interval" | "navigate" | "unload" | "manual";

export interface Hitl2SnapshotIn {
  trigger: Hitl2SnapshotTrigger;
  html_body: string;
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
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
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
}

export interface PersonaPatch {
  name?: string;
  voice_rules?: string[];
  banned_terms?: string[];
  required_phrasings?: string[];
  disclaimer_templates?: Record<string, DisclaimerTemplate>;
  tone_examples?: Record<string, string[]>;
  glossary?: GlossaryEntry[];
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
}

export type PromptTemplateCategory = "agent" | "partial";

export interface PromptTemplateListItem {
  template_id: string;
  filename: string;
  category: PromptTemplateCategory;
  sha256: string;
  bytes: number;
}

export interface PromptTemplateSchema {
  template_id: string;
  required_placeholders: string[];
  found_placeholders: string[];
  found_includes: string[];
  unknown_includes: string[];
}

export interface PromptTemplateConsumers {
  template_id: string;
  consumers: string[];
}

export interface PromptSaveResponse {
  template_id: string;
  sha256: string;
  bytes: number;
  version_id?: string;
  saved_at?: string;
  saved_by?: string;
}

export interface PromptPreviewResponse {
  resolved: string;
  route: string;
}

export type PromptVersionKind = "save" | "revert";

export interface PromptVersionSummary {
  version_id: string;
  sha256: string;
  parent_sha256: string | null;
  bytes: number;
  saved_by: string;
  saved_at: string;
  kind: PromptVersionKind;
}

export interface PromptVersionDetail extends PromptVersionSummary {
  template_id: string;
  body: string;
}

export interface PromptVersionsResponse {
  template_id: string;
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
  deny: { domains: string[] };
  prefer: { tlds: string[]; domains: string[] };
  community_exception: { topic_categories: string[]; allowed_domains: string[] };
}

export interface SourcePolicyResponse {
  policy_id: string;
  policy: SourcePolicyDoc;
  sha256: string;
  bytes: number;
  rendered: string;
}

export interface SourcePolicyPreviewResponse {
  policy: SourcePolicyDoc;
  rendered: string;
}

export interface SourcePolicySaveResponse extends SourcePolicyResponse {
  version_id: string;
  saved_at: string;
  saved_by: string;
}

export interface SourcePolicyVersionsResponse {
  policy_id: string;
  versions: PromptVersionSummary[];
}

export interface SourcePolicyVersionDetail extends PromptVersionSummary {
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
