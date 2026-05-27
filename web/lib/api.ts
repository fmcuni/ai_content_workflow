import type {
  Audit, Article, ArticleDetail, ArticleListResponse, BatchStatus, CreateRunRequest,
  DryPublishRequest, DryPublishResponse, ExistingPost, GapAnalysis, GraphMode,
  Hitl2Request, Outline, PatchCandidateIn, Persona, PersonaIn, PersonaPatch, PersonaUsage,
  PromoteRequest, PromoteResponse, PromptGraph, PromptTemplate, RefreshEvaluation, Render,
  RunSummary, ScanResponse, TopicBatch, TopicBatchCreateResponse, TopicBatchIn,
  TopicCandidate, UserPromptExample, WpCategoryOption, WpUserOption,
} from "./types";

const BASE = "/api/runs";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

export const api = {
  listRuns: (status?: string) =>
    http<RunSummary[]>(`${BASE}${status ? `?status=${status}` : ""}`),
  getRun: (runId: string) => http<RunSummary>(`${BASE}/${runId}`),
  createRun: (req: CreateRunRequest) =>
    http<{ run_id: string; status: string }>(BASE, { method: "POST", body: JSON.stringify(req) }),
  getGapAnalysis: (runId: string) => http<GapAnalysis>(`${BASE}/${runId}/gap-analysis`),
  getOutline: (runId: string) =>
    http<{ payload: Outline; edited_by_human: boolean }>(`${BASE}/${runId}/outline`),
  getLatestRender: (runId: string) => http<Render>(`${BASE}/${runId}/render`),
  getLatestAudit: (runId: string) => http<Audit>(`${BASE}/${runId}/audit`),
  resumeHitl1: (
    runId: string,
    body: { decision: "approve" | "edit_outline" | "override_route" | "cancel";
            edited_outline?: Outline; new_route?: "small_refresh" | "full_rewrite"; notes?: string },
  ) => http(`${BASE}/${runId}/resume`, { method: "POST", body: JSON.stringify(body) }),
  resumeHitl2: (runId: string, body: Hitl2Request) =>
    http(`${BASE}/${runId}/hitl-2`, { method: "POST", body: JSON.stringify(body) }),
  restartRun: (runId: string) =>
    http<{ ok: boolean }>(`${BASE}/${runId}/restart`, { method: "POST" }),
  dryPublish: (runId: string, body?: DryPublishRequest) =>
    http<DryPublishResponse>(`${BASE}/${runId}/dry-publish`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  getExistingPost: (runId: string) =>
    http<ExistingPost>(`${BASE}/${runId}/existing-post`),
  refreshExistingPost: (runId: string) =>
    http<ExistingPost>(`${BASE}/${runId}/existing-post/refresh`, { method: "POST" }),
  listWpUsers: () => http<WpUserOption[]>("/api/wp-options/users"),
  listWpCategories: () => http<WpCategoryOption[]>("/api/wp-options/categories"),
};

const ARTICLES_BASE = "/api/articles";
const REFRESH_BASE = "/api/refresh";

export const articlesApi = {
  list: async (params: {
    needs_refresh?: boolean; persona?: string; topic_category?: string;
    q?: string; sort?: "staleness" | "next_scan_due" | "last_persisted";
    limit?: number; offset?: number;
  }): Promise<ArticleListResponse> => {
    const qs = new URLSearchParams();
    if (params.needs_refresh !== undefined) qs.set("needs_refresh", String(params.needs_refresh));
    if (params.persona) qs.set("persona", params.persona);
    if (params.topic_category) qs.set("topic_category", params.topic_category);
    if (params.q) qs.set("q", params.q);
    if (params.sort) qs.set("sort", params.sort);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    return http<ArticleListResponse>(`${ARTICLES_BASE}?${qs.toString()}`);
  },
  detail: (articleId: string) => http<ArticleDetail>(`${ARTICLES_BASE}/${articleId}`),
  dismiss: (articleId: string, until: string, dismissedBy: string, reason?: string) =>
    http<Article>(`${ARTICLES_BASE}/${articleId}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ until, dismissed_by: dismissedBy, reason }),
    }),
  clearDismiss: (articleId: string) =>
    http<Article>(`${ARTICLES_BASE}/${articleId}/dismiss`, { method: "DELETE" }),
};

export const refreshApi = {
  scanAll: () => http<ScanResponse>(`${REFRESH_BASE}/scan`, { method: "POST", body: "{}" }),
  scanOne: (articleId: string, force = false) =>
    http<RefreshEvaluation>(`${REFRESH_BASE}/scan/${articleId}${force ? "?force=true" : ""}`, { method: "POST" }),
  getEvaluation: (evaluationId: string) =>
    http<RefreshEvaluation>(`${REFRESH_BASE}/evaluations/${evaluationId}`),
};

const PERSONAS_BASE = "/api/personas";
const PROMPTS_BASE = "/api/prompts";

export const personasApi = {
  list: (includeArchived = false) =>
    http<Persona[]>(`${PERSONAS_BASE}${includeArchived ? "?include_archived=true" : ""}`),
  get: (slug: string) => http<Persona>(`${PERSONAS_BASE}/${slug}`),
  create: (body: PersonaIn) =>
    http<Persona>(PERSONAS_BASE, { method: "POST", body: JSON.stringify(body) }),
  update: (slug: string, patch: PersonaPatch) =>
    http<Persona>(`${PERSONAS_BASE}/${slug}`, { method: "PUT", body: JSON.stringify(patch) }),
  archive: (slug: string) =>
    http<Persona>(`${PERSONAS_BASE}/${slug}/archive`, { method: "POST" }),
  restore: (slug: string) =>
    http<Persona>(`${PERSONAS_BASE}/${slug}/restore`, { method: "POST" }),
  usage: (slug: string) =>
    http<PersonaUsage>(`${PERSONAS_BASE}/${slug}/usage`),
};

const TOPIC_BATCHES_BASE = "/api/topic-batches";

export const topicBatchesApi = {
  create: (body: TopicBatchIn) =>
    http<TopicBatchCreateResponse>(TOPIC_BATCHES_BASE, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  list: (status?: BatchStatus) =>
    http<TopicBatch[]>(`${TOPIC_BATCHES_BASE}${status ? `?status=${status}` : ""}`),
  detail: (batchId: string) =>
    http<TopicBatch>(`${TOPIC_BATCHES_BASE}/${batchId}`),
  eventsUrl: (batchId: string) => {
    // SSE goes direct to the FastAPI host (Next rewrites buffer streams).
    const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "";
    return `${apiBase}/topic-batches/${batchId}/events`;
  },
  patchCandidate: (batchId: string, candidateId: string, body: PatchCandidateIn) =>
    http<TopicCandidate>(
      `${TOPIC_BATCHES_BASE}/${batchId}/candidates/${candidateId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  promote: (batchId: string, body: PromoteRequest) =>
    http<PromoteResponse>(`${TOPIC_BATCHES_BASE}/${batchId}/promote`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  skip: (batchId: string, candidateId: string, editorEmail: string) =>
    http<TopicCandidate>(
      `${TOPIC_BATCHES_BASE}/${batchId}/candidates/${candidateId}/skip`,
      { method: "POST", body: JSON.stringify({ editor_email: editorEmail }) },
    ),
  close: (batchId: string) =>
    http<TopicBatch>(`${TOPIC_BATCHES_BASE}/${batchId}/close`, { method: "POST" }),
};

export const promptsApi = {
  graph: (mode: GraphMode = "refresh") =>
    http<PromptGraph>(`${PROMPTS_BASE}/graph?mode=${mode}`),
  template: (id: string) => http<PromptTemplate>(`${PROMPTS_BASE}/templates/${id}`),
  userExample: (runId: string, agent: string) =>
    http<UserPromptExample>(`${PROMPTS_BASE}/user-example?run_id=${runId}&agent=${agent}`),
};
