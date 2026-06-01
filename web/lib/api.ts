import type {
  ApplyEditsRequest, ApplyEditsResponse,
  ArticleEditRequest, Audit, Article, ArticleDetail, ArticleListResponse, BatchStatus,
  CreateRunRequest, DryPublishRequest, DryPublishResponse, ExistingPost, GapAnalysis, GraphMode,
  Hitl2Request, Hitl2Snapshot, Hitl2SnapshotIn, Outline, PatchCandidateIn, Persona, PersonaIn,
  PersonaPatch, PersonaUsage,
  PromoteRequest, PromoteResponse, PromptGraph, PromptPreviewResponse, PromptRevertResponse,
  PromptSaveResponse, PromptTemplate, PromptTemplateConsumers, PromptTemplateListItem,
  PromptTemplateSchema, PromptVersionDetail, PromptVersionsResponse,
  RefreshEvaluation, RegenerateRequest, Render, RepublishResponse, RunSummary, ScanResponse,
  SetupConfigureResult, SetupRequest, SetupStatus, SetupVerifyResult,
  SourcePolicyDoc, SourcePolicyPreviewResponse, SourcePolicyResponse, SourcePolicyRevertResponse,
  SourcePolicySaveResponse, SourcePolicyVersionDetail, SourcePolicyVersionsResponse,
  TopicBatch, TopicBatchCreateResponse, TopicBatchIn, TopicCandidate, UserPromptExample,
  WpCategoryOption, WpUserOption,
} from "./types";

const BASE = "/api/runs";

// The reverse proxy is the source of truth in production; in local dev we
// pre-fill the header from this env so the API's _require_editor stamps the
// version row with a real-looking identity instead of "dev@local".
const PROMPT_EDITOR_EMAIL = process.env.NEXT_PUBLIC_PROMPT_EDITOR_EMAIL;

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const extra: Record<string, string> = {};
  if (
    PROMPT_EDITOR_EMAIL &&
    (path.startsWith("/api/prompts/") || path.startsWith("/api/source-policy"))
  ) {
    extra["X-Editor-Email"] = PROMPT_EDITOR_EMAIL;
  }
  const r = await fetch(path, {
    ...init,
    // Carry the better-auth session cookie (same-origin via the /api proxy).
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...extra,
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

// Desktop first-run setup. `configure` expects a 400 with a `checks` body when
// credentials fail verification, so it branches on status instead of letting the
// generic `http` helper throw on that (expected) case.
export const setupApi = {
  status: () => http<SetupStatus>("/api/setup/status"),
  verify: (body: SetupRequest) =>
    http<SetupVerifyResult>("/api/setup/verify", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  configure: async (body: SetupRequest): Promise<SetupConfigureResult> => {
    const r = await fetch("/api/setup", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    if (r.status === 400) {
      const data = (await r.json()) as { detail?: string; checks?: SetupVerifyResult };
      if (data.detail === "verification_failed" && data.checks) {
        return { ok: false, reason: "verification_failed", checks: data.checks };
      }
    }
    throw new Error(`${r.status}: ${await r.text()}`);
  },
};

export const api = {
  listRuns: (status?: string) =>
    http<RunSummary[]>(`${BASE}${status ? `?status=${status}` : ""}`),
  getRun: (runId: string) => http<RunSummary>(`${BASE}/${runId}`),
  createRun: (req: CreateRunRequest) =>
    http<{ run_id: string; status: string }>(BASE, { method: "POST", body: JSON.stringify(req) }),
  getGapAnalysis: (runId: string) => http<GapAnalysis>(`${BASE}/${runId}/gap-analysis`),
  getOutline: (runId: string) =>
    http<{ payload: Outline; edited_by_human: boolean; human_edits: Outline | null }>(
      `${BASE}/${runId}/outline`,
    ),
  saveOutline: (runId: string, outline: Outline) =>
    http<{ ok: boolean }>(`${BASE}/${runId}/outline`, {
      method: "PUT",
      body: JSON.stringify({ outline }),
    }),
  saveArticle: (runId: string, body: ArticleEditRequest) =>
    http<{ ok: boolean }>(`${BASE}/${runId}/article`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  republish: (runId: string) =>
    http<RepublishResponse>(`${BASE}/${runId}/republish`, { method: "POST" }),
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
  deleteRun: (runId: string) =>
    http<{ ok: boolean }>(`${BASE}/${runId}`, { method: "DELETE" }),
  regenerate: (runId: string, body: RegenerateRequest) =>
    http<{ ok: boolean; iteration: number; draft_id: string }>(
      `${BASE}/${runId}/regenerate`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  applyEdits: (runId: string, body: ApplyEditsRequest) =>
    http<ApplyEditsResponse>(`${BASE}/${runId}/apply-edits`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
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
  saveHitl2Snapshot: (runId: string, body: Hitl2SnapshotIn) =>
    http<Hitl2Snapshot>(`${BASE}/${runId}/hitl2-snapshots`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listHitl2Snapshots: (runId: string) =>
    http<Hitl2Snapshot[]>(`${BASE}/${runId}/hitl2-snapshots`),
  // Fire-and-forget save for tab close / reload, where an awaited fetch would be
  // cancelled. sendBeacon survives page teardown; returns false if it couldn't queue.
  beaconHitl2Snapshot: (runId: string, body: Hitl2SnapshotIn): boolean => {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
    const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
    return navigator.sendBeacon(`${BASE}/${runId}/hitl2-snapshots`, blob);
  },
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
  delete: (batchId: string) =>
    http<{ ok: boolean }>(`${TOPIC_BATCHES_BASE}/${batchId}`, { method: "DELETE" }),
};

export const promptsApi = {
  graph: (mode: GraphMode = "refresh") =>
    http<PromptGraph>(`${PROMPTS_BASE}/graph?mode=${mode}`),
  template: (id: string) => http<PromptTemplate>(`${PROMPTS_BASE}/templates/${id}`),
  userExample: (runId: string, agent: string) =>
    http<UserPromptExample>(`${PROMPTS_BASE}/user-example?run_id=${runId}&agent=${agent}`),
  listTemplates: () =>
    http<{ templates: PromptTemplateListItem[] }>(`${PROMPTS_BASE}/templates`),
  templateSchema: (id: string) =>
    http<PromptTemplateSchema>(`${PROMPTS_BASE}/templates/${id}/schema`),
  templateConsumers: (id: string) =>
    http<PromptTemplateConsumers>(`${PROMPTS_BASE}/templates/${id}/consumers`),
  saveTemplate: (id: string, body: { template: string; expected_sha256: string }) =>
    http<PromptSaveResponse>(`${PROMPTS_BASE}/templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  previewTemplate: (
    id: string,
    body: { template: string; route?: string; context?: Record<string, string> },
  ) =>
    http<PromptPreviewResponse>(`${PROMPTS_BASE}/templates/${id}/preview`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  templateHistory: (id: string, limit = 50) =>
    http<PromptVersionsResponse>(
      `${PROMPTS_BASE}/templates/${id}/history?limit=${limit}`,
    ),
  templateVersion: (id: string, versionId: string) =>
    http<PromptVersionDetail>(
      `${PROMPTS_BASE}/templates/${id}/versions/${versionId}`,
    ),
  revertTemplate: (
    id: string,
    body: { target_version_id: string; expected_sha256: string },
  ) =>
    http<PromptRevertResponse>(`${PROMPTS_BASE}/templates/${id}/revert`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

const SOURCE_POLICY_BASE = "/api/source-policy";

export const sourcePolicyApi = {
  get: () => http<SourcePolicyResponse>(SOURCE_POLICY_BASE),
  preview: (policy: SourcePolicyDoc) =>
    http<SourcePolicyPreviewResponse>(`${SOURCE_POLICY_BASE}/preview`, {
      method: "POST",
      body: JSON.stringify({ policy }),
    }),
  save: (body: { policy: SourcePolicyDoc; expected_sha256: string }) =>
    http<SourcePolicySaveResponse>(SOURCE_POLICY_BASE, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  history: (limit = 50) =>
    http<SourcePolicyVersionsResponse>(`${SOURCE_POLICY_BASE}/history?limit=${limit}`),
  version: (versionId: string) =>
    http<SourcePolicyVersionDetail>(`${SOURCE_POLICY_BASE}/versions/${versionId}`),
  revert: (body: { target_version_id: string; expected_sha256: string }) =>
    http<SourcePolicyRevertResponse>(`${SOURCE_POLICY_BASE}/revert`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
