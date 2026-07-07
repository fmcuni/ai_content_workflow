import type {
  AdminUser, MeResponse, UserRole,
  ApplyEditsRequest, ApplyEditsResponse,
  ArticleEditRequest, Audit, Article, ArticleDetail, ArticleListResponse, BatchStatus,
  CreateRunRequest, DryPublishRequest, DryPublishResponse, ExistingPost, GapAnalysis, GlossaryEntry, GraphMode,
  Hitl2Request, Hitl2Snapshot, Hitl2SnapshotIn, Outline, PatchCandidateIn, Persona, PersonaIn,
  RunDraft,
  PersonaPatch, PersonaUsage, PublishTarget,
  PublishTargetCreate, PublishTargetReadiness, PublishTargetUpdate, PublishTargetUsage,
  PromoteRequest, PromoteResponse, PromptGraph, PromptPreviewResponse, PromptRevertResponse,
  PromptSaveResponse, PromptTemplate, PromptTemplateConsumers, PromptTemplateListResponse,
  PromptTemplateSchema, PromptVersionDetail, PromptVersionsResponse, VoiceLocale,
  RefreshEvaluation, Render, RepublishResponse, ReviewThread, CreateReviewThreadIn,
  RunCost, RunEventLog, RunSummary,
  RunWpMetaPatch, ScanResponse,
  SetupConfigureResult, SetupRequest, SetupStatus, SetupVerifyResult,
  SourcePolicyDoc, SourcePolicyPreviewResponse, SourcePolicyResponse, SourcePolicyRevertResponse,
  SourcePolicySaveResponse, SourcePolicyVersionDetail, SourcePolicyVersionsResponse,
  TopicBatch, TopicBatchCreateResponse, TopicBatchDefaultsPatch, TopicBatchIn, TopicCandidate,
  UserPromptExample,
  WpCategoryOption, WpUserOption,
  GhostAuthorOption, GhostTagOption, MediaUploadResult,
} from "./types";

import { getSessionEmail } from "./auth-client";
import { isAuthRoute } from "./auth-routes";
import { getSupabaseClient } from "./supabase-client";

const BASE = "/api/runs";

// Requests carry the Supabase access token as a Bearer header (the backend
// validates the JWT). `forceRefresh` asks Supabase to mint a fresh token from
// the refresh token — used once after a 401.
async function supabaseBearer(forceRefresh = false): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  if (forceRefresh) {
    const { data } = await supabase.auth.refreshSession();
    return data.session?.access_token ?? null;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// Send the browser to /login, preserving where we were so we can return after
// re-auth. No-op during SSR. Used when a Supabase 401 survives a token refresh.
// Guard so a burst of concurrent 401s (e.g. TanStack Query retrying several
// in-flight requests after the session expires) triggers exactly one navigation
// instead of racing multiple `assign()` calls.
let redirectingToLogin = false;
/**
 * Build the `/login` URL to send an unauthenticated user to — or `null` when NO
 * redirect should happen because we're already on an auth page (login/signup/
 * verify). Pure + exported for testing.
 *
 * Returning null on auth routes is what prevents an infinite refresh loop: authed
 * calls fire on those pages too (e.g. Masthead's `useRole` → `/me`), and once
 * `/me` 401s (an unprovisioned/expired session), a redirect to `/login` would
 * reload the page → re-fire `/me` → 401 → reload, forever. Also strips any
 * existing `redirect` param so repeated 401s can't nest `?redirect=%3F…`.
 */
export function buildLoginUrl(pathname: string, search: string): string | null {
  if (isAuthRoute(pathname)) return null;
  const params = new URLSearchParams(search);
  params.delete("redirect");
  const cleaned = params.toString();
  const here = pathname + (cleaned ? `?${cleaned}` : "");
  return `/login?redirect=${encodeURIComponent(here)}`;
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (redirectingToLogin) return;
  const url = buildLoginUrl(window.location.pathname, window.location.search);
  if (url === null) return; // already on an auth page — do not reload it
  redirectingToLogin = true;
  window.location.assign(url);
}

/**
 * Build the `?run_id=…&persona=…` query for the /wp-options endpoints. Either
 * scopes the lookup to one CMS instance: `persona` (voice slug — the /runs board
 * uses this so rows of the same voice share a cache entry) takes precedence over
 * `runId` (the HITL_2 picker). Neither → the legacy Bowtie default.
 */
function wpOptionsQuery(runId?: string, persona?: string): string {
  const params = new URLSearchParams();
  if (runId) params.set("run_id", runId);
  if (persona) params.set("persona", persona);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Upload an image to the run's CMS media store (kind-resolved server-side).
 * Multipart — we must NOT set content-type so the browser writes the boundary.
 * Mirrors `http`'s Bearer attach + single 401 refresh-and-retry.
 */
export async function uploadMedia(
  file: File,
  opts: { runId?: string; persona?: string } = {},
): Promise<MediaUploadResult> {
  const url = `/api/media/upload${wpOptionsQuery(opts.runId, opts.persona)}`;
  const send = async (token: string | null): Promise<Response> => {
    const body = new FormData();
    body.append("file", file, file.name || "upload");
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    return fetch(url, { method: "POST", credentials: "include", headers, body });
  };
  let resp = await send(await supabaseBearer());
  if (resp.status === 401) {
    const refreshed = await supabaseBearer(true);
    if (refreshed) resp = await send(refreshed);
  }
  if (!resp.ok) {
    let detail = `upload failed (${resp.status})`;
    try {
      const j = (await resp.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await resp.json()) as MediaUploadResult;
}

// Build-time fallback only (local dev). In production the signed-in editor's
// Supabase session email is the primary source — see `resolveEditorEmail`.
const PROMPT_EDITOR_EMAIL = process.env.NEXT_PUBLIC_PROMPT_EDITOR_EMAIL;

// Cache the resolved editor email for the page session so we hit the session
// endpoint at most once. `undefined` = not yet resolved, `null` = resolved to
// "no session" (then the env fallback applies). A reload clears this.
let cachedEditorEmail: string | null | undefined;

/**
 * Resolve the email to stamp prompt/source-policy edits with. Prefers the
 * logged-in Supabase session (so the version row shows the real editor, not
 * "dev@local"), falling back to the build-time env for local dev. The backend
 * trusts this `X-Editor-Email` header; RBAC permission is enforced server-side
 * independently of the stamped identity.
 */
async function resolveEditorEmail(): Promise<string | undefined> {
  if (cachedEditorEmail === undefined) {
    try {
      cachedEditorEmail = await getSessionEmail();
    } catch {
      cachedEditorEmail = null;
    }
  }
  return cachedEditorEmail ?? PROMPT_EDITOR_EMAIL;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const extra: Record<string, string> = {};
  const method = (init?.method ?? "GET").toUpperCase();
  const isWrite = method !== "GET" && method !== "HEAD";
  if (
    isWrite &&
    (path.startsWith("/api/prompts/") || path.startsWith("/api/source-policy"))
  ) {
    const editorEmail = await resolveEditorEmail();
    if (editorEmail) extra["X-Editor-Email"] = editorEmail;
  }

  const token = await supabaseBearer();
  if (token) extra["authorization"] = `Bearer ${token}`;

  function buildInit(): RequestInit {
    return {
      ...init,
      // The Supabase path uses the Bearer header above; `credentials: "include"`
      // is harmless here and kept for the local-dev /api proxy path.
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...extra,
        ...(init?.headers ?? {}),
      },
    };
  }

  let r = await fetch(path, buildInit());

  // A 401 usually means the access token expired. Try one silent refresh +
  // retry; if it still fails, the session is gone → go to /login.
  if (r.status === 401) {
    const refreshed = await supabaseBearer(true);
    if (refreshed) {
      extra["authorization"] = `Bearer ${refreshed}`;
      r = await fetch(path, buildInit());
    }
    if (r.status === 401) {
      redirectToLogin();
      throw new Error("401: session expired");
    }
  }

  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  // A 204 No Content (or any empty body) carries no JSON — DELETE routes return
  // `204` with a null body. Calling `r.json()` on it throws "Unexpected end of
  // JSON input", which silently failed mutations like deleting a review thread.
  // Callers of these endpoints type `T` as `void`, so returning undefined is safe.
  if (r.status === 204 || r.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await r.json()) as T;
}

/**
 * `http()` throws `Error("<status>: <raw body>")`. When the body is JSON with a
 * `detail` field (e.g. the 409 target-mismatch response — issue #15), pull that
 * out for display; otherwise fall back to the raw message.
 */
export function apiErrorDetail(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const body = message.slice(message.indexOf(": ") + 2);
  try {
    const parsed = JSON.parse(body) as { detail?: string };
    if (parsed.detail) return parsed.detail;
  } catch {
    // not JSON — fall through to the raw message
  }
  return message;
}

// Persisted per-step event-log query params, shared by the run and
// topic-batch log endpoints. `since_seq` enables incremental polling.
export interface LogQueryParams {
  since_seq?: number;
  limit?: number;
  level?: string;
}

function logQueryString(params?: LogQueryParams): string {
  if (!params) return "";
  const qs = new URLSearchParams();
  if (params.since_seq !== undefined) qs.set("since_seq", String(params.since_seq));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.level !== undefined) qs.set("level", params.level);
  const s = qs.toString();
  return s ? `?${s}` : "";
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
  // Ledger inline edit: partial update of a run's destination / brief fields.
  // Returns the new render version (null when the run has no draft yet).
  patchRun: (runId: string, body: RunWpMetaPatch) =>
    http<{ ok: boolean; version: number | null }>(`${BASE}/${runId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  republish: (runId: string) =>
    http<RepublishResponse>(`${BASE}/${runId}/republish`, { method: "POST" }),
  getLatestRender: (runId: string) => http<Render>(`${BASE}/${runId}/render`),
  getLatestAudit: (runId: string) => http<Audit>(`${BASE}/${runId}/audit`),
  // Cost lives under /costs (not /api/runs); 404s for runs with no usage yet.
  getRunCost: (runId: string) => http<RunCost>(`/api/costs/run/${runId}`),
  resumeHitl1: (
    runId: string,
    body: { decision: "approve" | "edit_outline" | "override_route" | "cancel";
            edited_outline?: Outline; new_route?: "small_refresh" | "full_rewrite"; notes?: string },
  ) => http(`${BASE}/${runId}/resume`, { method: "POST", body: JSON.stringify(body) }),
  resumeHitl2: (runId: string, body: Hitl2Request) =>
    http(`${BASE}/${runId}/hitl-2`, { method: "POST", body: JSON.stringify(body) }),
  restartRun: (runId: string) =>
    http<{ ok: boolean }>(`${BASE}/${runId}/restart`, { method: "POST" }),
  getRunLogs: (runId: string, params?: LogQueryParams) =>
    http<RunEventLog[]>(`${BASE}/${runId}/logs${logQueryString(params)}`),
  deleteRun: (runId: string) =>
    http<{ ok: boolean }>(`${BASE}/${runId}`, { method: "DELETE" }),
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
  listWpUsers: (runId?: string, persona?: string) =>
    http<WpUserOption[]>(`/api/wp-options/users${wpOptionsQuery(runId, persona)}`),
  listWpCategories: (runId?: string, persona?: string) =>
    http<WpCategoryOption[]>(`/api/wp-options/categories${wpOptionsQuery(runId, persona)}`),
  listGhostAuthors: (runId?: string, persona?: string) =>
    http<GhostAuthorOption[]>(`/api/ghost-options/authors${wpOptionsQuery(runId, persona)}`),
  listGhostTags: (runId?: string, persona?: string) =>
    http<GhostTagOption[]>(`/api/ghost-options/tags${wpOptionsQuery(runId, persona)}`),
  saveHitl2Snapshot: (runId: string, body: Hitl2SnapshotIn) =>
    http<Hitl2Snapshot>(`${BASE}/${runId}/hitl2-snapshots`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listHitl2Snapshots: (runId: string) =>
    http<Hitl2Snapshot[]>(`${BASE}/${runId}/hitl2-snapshots`),
  // Draft iterations (with render body) for the unified version-history
  // timeline. Newest-first by iteration; only iterations with a render appear.
  listRunDrafts: (runId: string) =>
    http<RunDraft[]>(`${BASE}/${runId}/drafts`),
  // Fire-and-forget save for tab close / reload, where an awaited fetch would be
  // cancelled. sendBeacon survives page teardown; returns false if it couldn't queue.
  beaconHitl2Snapshot: (runId: string, body: Hitl2SnapshotIn): boolean => {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
    const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
    return navigator.sendBeacon(`${BASE}/${runId}/hitl2-snapshots`, blob);
  },
  // Review threads — human-only highlight discussions. SEPARATE from the AI-edit
  // `comments` path; never sent to apply-edits.
  listReviewThreads: (runId: string) =>
    http<ReviewThread[]>(`${BASE}/${runId}/review-threads`),
  createReviewThread: (runId: string, body: CreateReviewThreadIn) =>
    http<ReviewThread>(`${BASE}/${runId}/review-threads`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  replyReviewThread: (
    runId: string,
    threadId: string,
    body: { body: string; editor_email?: string | null; editor_name?: string | null },
  ) =>
    http<ReviewThread>(`${BASE}/${runId}/review-threads/${threadId}/replies`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  resolveReviewThread: (
    runId: string,
    threadId: string,
    body: { resolved: boolean; editor_email?: string | null; editor_name?: string | null },
  ) =>
    http<ReviewThread>(`${BASE}/${runId}/review-threads/${threadId}/resolve`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteReviewThread: (runId: string, threadId: string) =>
    http<void>(`${BASE}/${runId}/review-threads/${threadId}`, { method: "DELETE" }),
};

// Identity + role. `/me` is served by the Workers backend; the local Python dev
// backend has no such route, so callers (useRole) treat a failure as dev mode.
export const meApi = {
  get: () => http<MeResponse>("/api/me"),
};

// Admin user-management (Supabase Auth provider). Admin-gated server-side (403
// for non-admins); the UI also hides/blocks these for non-admins as defense in
// depth. Reuses the shared http() helper.
const ADMIN_USERS_BASE = "/api/admin/users";

//
// Backend enriches list rows with GoTrue facets (status / last_sign_in /
// confirmed) on the supabase provider; AdminUserDetail is the superset the UI
// reads. The base AdminUser type stays frozen — these extra fields are optional.

/** A listed user with the optional GoTrue-enriched facets (supabase provider). */
export interface AdminUserDetail extends AdminUser {
  status?: "active" | "disabled";
  last_sign_in_at?: string | null;
  confirmed?: boolean;
}

/** Body for POST /admin/users (create + invite). */
export interface CreateUserRequest {
  email: string;
  role: UserRole;
}

export const adminUsersApi = {
  list: () => http<AdminUserDetail[]>(ADMIN_USERS_BASE),
  create: (body: CreateUserRequest) =>
    http<AdminUserDetail>(ADMIN_USERS_BASE, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  setRole: (id: string, role: UserRole) =>
    http<AdminUserDetail>(`${ADMIN_USERS_BASE}/${id}/role`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  disable: (id: string) =>
    http<AdminUserDetail>(`${ADMIN_USERS_BASE}/${id}/disable`, { method: "POST" }),
  enable: (id: string) =>
    http<AdminUserDetail>(`${ADMIN_USERS_BASE}/${id}/enable`, { method: "POST" }),
  remove: (id: string) => http<void>(`${ADMIN_USERS_BASE}/${id}`, { method: "DELETE" }),
  revokeSessions: (id: string) =>
    http<{ ok: boolean }>(`${ADMIN_USERS_BASE}/${id}/revoke-sessions`, { method: "POST" }),
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
  // Deep-copy an existing voice into a new slug/name: clones the persona row +
  // the source voice's agent/partial prompt templates + source policy in one
  // transaction. 404 unknown source; 409 if the target slug already exists.
  duplicate: (sourceSlug: string, body: { slug: string; name: string }) =>
    http<Persona>(`${PERSONAS_BASE}/${sourceSlug}/duplicate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (slug: string, patch: PersonaPatch) =>
    http<Persona>(`${PERSONAS_BASE}/${slug}`, { method: "PUT", body: JSON.stringify(patch) }),
  archive: (slug: string) =>
    http<Persona>(`${PERSONAS_BASE}/${slug}/archive`, { method: "POST" }),
  restore: (slug: string) =>
    http<Persona>(`${PERSONAS_BASE}/${slug}/restore`, { method: "POST" }),
  usage: (slug: string) =>
    http<PersonaUsage>(`${PERSONAS_BASE}/${slug}/usage`),
};

const PUBLISH_TARGETS_BASE = "/api/publish-targets";

export const publishTargetsApi = {
  list: (includeArchived = false) =>
    http<PublishTarget[]>(
      `${PUBLISH_TARGETS_BASE}${includeArchived ? "?include_archived=true" : ""}`,
    ),
  create: (body: PublishTargetCreate) =>
    http<PublishTarget>(PUBLISH_TARGETS_BASE, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: PublishTargetUpdate) =>
    http<PublishTarget>(`${PUBLISH_TARGETS_BASE}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  archive: (id: string) =>
    http<PublishTarget>(`${PUBLISH_TARGETS_BASE}/${id}/archive`, {
      method: "POST",
    }),
  restore: (id: string) =>
    http<PublishTarget>(`${PUBLISH_TARGETS_BASE}/${id}/restore`, {
      method: "POST",
    }),
  usage: (id: string) =>
    http<PublishTargetUsage>(`${PUBLISH_TARGETS_BASE}/${id}/usage`),
  readiness: (id: string) =>
    http<PublishTargetReadiness>(`${PUBLISH_TARGETS_BASE}/${id}/readiness`),
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
  // Ledger band inline edit: partial update of a batch's promotion defaults.
  patch: (batchId: string, body: TopicBatchDefaultsPatch) =>
    http<TopicBatch>(`${TOPIC_BATCHES_BASE}/${batchId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  getLogs: (batchId: string, params?: LogQueryParams) =>
    http<RunEventLog[]>(`${TOPIC_BATCHES_BASE}/${batchId}/logs${logQueryString(params)}`),
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
  // Re-run dedup + hot for a candidate whose verdict errored (last_error set).
  retryVerdict: (batchId: string, candidateId: string) =>
    http<TopicCandidate>(
      `${TOPIC_BATCHES_BASE}/${batchId}/candidates/${candidateId}/retry-verdict`,
      { method: "POST" },
    ),
  close: (batchId: string) =>
    http<TopicBatch>(`${TOPIC_BATCHES_BASE}/${batchId}/close`, { method: "POST" }),
  delete: (batchId: string) =>
    http<{ ok: boolean }>(`${TOPIC_BATCHES_BASE}/${batchId}`, { method: "DELETE" }),
};

// The prompt library + source policy are scoped per voice (persona slug). Every
// template/policy call carries `?voice=<slug>`; an absent param defaults to
// bowtie-editor server-side. Callers always pass the selected voice so query
// keys stay voice-scoped and switching voice refetches.
function voiceQuery(voice: string, extra?: Record<string, string | number>): string {
  const qs = new URLSearchParams();
  qs.set("voice", voice);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));
  }
  return `?${qs.toString()}`;
}

/**
 * Optional unsaved-draft inputs the Voice Studio sends with a consumer preview so
 * the assembled output reflects in-progress edits before they are saved. All keys
 * are optional and snake_case on the wire; an empty object is byte-identical to a
 * plain preview (the backend defaults each to the persona's stored value).
 */
export interface PreviewDraftInputs {
  context?: Record<string, string>;
  /** Other unsaved partial drafts, keyed by partial template id → body. The
   * focused template (the `template` field) always wins over a same-id entry. */
  partial_overrides?: Record<string, string>;
  /** Unsaved locale override → resolves the persona-block / locale tokens. */
  locale?: VoiceLocale;
  /** Unsaved structured source policy → rendered into {source_policy_block}. */
  source_policy?: SourcePolicyDoc;
  /** Unsaved glossary → folded into the persona block's glossary section. */
  glossary?: GlossaryEntry[];
}

export const promptsApi = {
  graph: (mode: GraphMode = "refresh") =>
    http<PromptGraph>(`${PROMPTS_BASE}/graph?mode=${mode}`),
  template: (id: string, voice: string) =>
    http<PromptTemplate>(`${PROMPTS_BASE}/templates/${id}${voiceQuery(voice)}`),
  userExample: (runId: string, agent: string) =>
    http<UserPromptExample>(`${PROMPTS_BASE}/user-example?run_id=${runId}&agent=${agent}`),
  listTemplates: (voice: string) =>
    http<PromptTemplateListResponse>(`${PROMPTS_BASE}/templates${voiceQuery(voice)}`),
  templateSchema: (id: string, voice: string) =>
    http<PromptTemplateSchema>(`${PROMPTS_BASE}/templates/${id}/schema${voiceQuery(voice)}`),
  templateConsumers: (id: string, voice: string) =>
    http<PromptTemplateConsumers>(`${PROMPTS_BASE}/templates/${id}/consumers${voiceQuery(voice)}`),
  saveTemplate: (
    id: string,
    voice: string,
    body: { template: string; expected_sha256: string; note?: string | null },
  ) =>
    http<PromptSaveResponse>(`${PROMPTS_BASE}/templates/${id}${voiceQuery(voice)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  previewTemplate: (
    id: string,
    voice: string,
    body: { template: string; route?: string } & PreviewDraftInputs,
  ) =>
    http<PromptPreviewResponse>(`${PROMPTS_BASE}/templates/${id}/preview${voiceQuery(voice)}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  templateHistory: (id: string, voice: string, limit = 50) =>
    http<PromptVersionsResponse>(
      `${PROMPTS_BASE}/templates/${id}/history${voiceQuery(voice, { limit })}`,
    ),
  templateVersion: (id: string, voice: string, versionId: string) =>
    http<PromptVersionDetail>(
      `${PROMPTS_BASE}/templates/${id}/versions/${versionId}${voiceQuery(voice)}`,
    ),
  revertTemplate: (
    id: string,
    voice: string,
    body: { target_version_id: string; expected_sha256: string },
  ) =>
    http<PromptRevertResponse>(`${PROMPTS_BASE}/templates/${id}/revert${voiceQuery(voice)}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

const SOURCE_POLICY_BASE = "/api/source-policy";

export const sourcePolicyApi = {
  get: (voice: string) =>
    http<SourcePolicyResponse>(`${SOURCE_POLICY_BASE}${voiceQuery(voice)}`),
  preview: (voice: string, policy: SourcePolicyDoc) =>
    http<SourcePolicyPreviewResponse>(`${SOURCE_POLICY_BASE}/preview${voiceQuery(voice)}`, {
      method: "POST",
      body: JSON.stringify({ policy }),
    }),
  save: (
    voice: string,
    body: { policy: SourcePolicyDoc; expected_sha256: string; note?: string | null },
  ) =>
    http<SourcePolicySaveResponse>(`${SOURCE_POLICY_BASE}${voiceQuery(voice)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  history: (voice: string, limit = 50) =>
    http<SourcePolicyVersionsResponse>(
      `${SOURCE_POLICY_BASE}/history${voiceQuery(voice, { limit })}`,
    ),
  version: (voice: string, versionId: string) =>
    http<SourcePolicyVersionDetail>(
      `${SOURCE_POLICY_BASE}/versions/${versionId}${voiceQuery(voice)}`,
    ),
  revert: (voice: string, body: { target_version_id: string; expected_sha256: string }) =>
    http<SourcePolicyRevertResponse>(`${SOURCE_POLICY_BASE}/revert${voiceQuery(voice)}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
