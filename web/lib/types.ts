export type RunStatus =
  | "pending" | "fetching" | "strategy" | "hitl_1"
  | "production" | "hitl_2" | "persisted" | "failed"
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
}

export interface CreateRunRequest {
  article_url: string;
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
