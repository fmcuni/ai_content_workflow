import type {
  Audit, Article, ArticleDetail, ArticleListResponse, CreateRunRequest, GapAnalysis,
  Hitl2Request, Outline, RefreshEvaluation, Render, RunSummary, ScanResponse,
  WpCategoryOption, WpUserOption,
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
