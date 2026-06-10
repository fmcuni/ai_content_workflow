/**
 * Thin GoTrue (Supabase Auth) admin REST wrapper — Worker-only.
 *
 * This module is the ONLY place the Supabase `service_role` key is read and the
 * ONLY place it is sent anywhere. SECURITY CONTRACT (enforced by the WS3
 * security self-review):
 *   - The key flows ONLY into the `Authorization`/`apikey` headers of a GoTrue
 *     admin REST call against `${SUPABASE_URL}/auth/v1/...`. It is never logged,
 *     never returned to a caller, and never embedded in an error message.
 *   - Every exported function fails CLOSED with a typed `GoTrueAdminError` when
 *     `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are unset, so an unconfigured
 *     environment cannot silently no-op or leak.
 *   - Inputs are validated (non-empty email/id) before any
 *     network call, and `SUPABASE_URL` is parsed via `new URL(...)` so a
 *     malformed base can never produce a surprising request target.
 *
 * GoTrue endpoints (relative to `${SUPABASE_URL}/auth/v1`):
 *   POST   /invite                       — send an invite email           {email}
 *   POST   /admin/users                  — create a user                  {email,password?,email_confirm}
 *   DELETE /admin/users/:id              — delete a user
 *   PUT    /admin/users/:id              — update (ban/unban)             {ban_duration}
 *   POST   /admin/users/:id/logout       — revoke all sessions
 *   GET    /admin/users?page=&per_page=  — list users
 *
 * No `@supabase/supabase-js` on the Worker (per WS0): admin calls are raw fetch.
 */

/** A GoTrue user as returned by the admin endpoints (only fields we consume). */
export interface GoTrueUser {
  id: string;
  email: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_sign_in_at?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  invited_at?: string | null;
  banned_until?: string | null;
}

/**
 * Typed error for all GoTrue admin failures. The `message` is always a safe,
 * caller-presentable string — it NEVER contains the service_role key. GoTrue
 * error bodies (which describe the auth state, not the secret) may be folded in
 * to aid debugging, but the secret itself is held only in request headers.
 */
export class GoTrueAdminError extends Error {
  readonly status: number;
  /** A stable machine code for the route layer to branch on. */
  readonly code: "not_configured" | "invalid_input" | "gotrue_error" | "network_error";

  constructor(code: GoTrueAdminError["code"], message: string, status: number) {
    super(message);
    this.name = "GoTrueAdminError";
    this.code = code;
    this.status = status;
  }
}

/** Minimal env shape this module needs (subset of the Worker `Env`). */
export interface GoTrueAdminEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

/** Resolved, validated config. Built per call; never cached with the key. */
interface ResolvedConfig {
  baseUrl: string;
  serviceRoleKey: string;
}

/**
 * Resolve + validate the GoTrue base URL and service_role key. Fails closed
 * with a `not_configured` error when either is missing/blank, and validates the
 * URL via `new URL` so a malformed `SUPABASE_URL` cannot yield a surprising
 * request target. Returns the `/auth/v1` base.
 */
function resolveConfig(env: GoTrueAdminEnv): ResolvedConfig {
  const url = (env.SUPABASE_URL ?? "").trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (url.length === 0 || key.length === 0) {
    throw new GoTrueAdminError(
      "not_configured",
      "Supabase Auth is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset)",
      501,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The malformed value is NOT echoed (keep the message generic so logs never
    // carry config internals).
    throw new GoTrueAdminError("not_configured", "SUPABASE_URL is not a valid URL", 501);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new GoTrueAdminError("not_configured", "SUPABASE_URL must be http(s)", 501);
  }
  // Normalize to `<origin>/auth/v1` regardless of any path / trailing slash.
  const baseUrl = `${parsed.origin}/auth/v1`;
  return { baseUrl, serviceRoleKey: key };
}

/** Trim + non-empty guard for a required string input. */
function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GoTrueAdminError("invalid_input", `${field} is required`, 400);
  }
  return value.trim();
}

/** Lightweight email shape check (defense in depth; GoTrue validates too). */
function requireEmail(value: unknown): string {
  const email = requireNonEmpty(value, "email");
  // Conservative: exactly one @, non-empty local + domain, a dot in the domain.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GoTrueAdminError("invalid_input", "email is not a valid address", 400);
  }
  return email;
}

/**
 * Core admin fetch. Attaches the service_role key to BOTH `apikey` and
 * `Authorization: Bearer` (the Supabase gateway requires both). On a non-2xx
 * response, reads the GoTrue error body (which never contains our secret) and
 * folds a short form into a typed error.
 */
async function adminFetch(
  cfg: ResolvedConfig,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e: unknown) {
    // Network/transport failure. `e` cannot carry our header value.
    const detail = e instanceof Error ? e.message : "unknown transport error";
    throw new GoTrueAdminError("network_error", `GoTrue request failed: ${detail}`, 502);
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const msg = extractGoTrueMessage(parsed) ?? `GoTrue admin call failed (${res.status})`;
    throw new GoTrueAdminError("gotrue_error", msg, res.status);
  }
  return parsed;
}

/** Pull a human message out of a GoTrue error body without leaking internals. */
function extractGoTrueMessage(parsed: unknown): string | null {
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const candidate = obj.msg ?? obj.message ?? obj.error_description ?? obj.error;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Send an invite email to `email`. Returns the created/invited GoTrue user. */
export async function inviteUser(env: GoTrueAdminEnv, email: string): Promise<GoTrueUser> {
  const cfg = resolveConfig(env);
  const validEmail = requireEmail(email);
  const user = await adminFetch(cfg, "POST", "/invite", { email: validEmail });
  return user as GoTrueUser;
}

/**
 * Create a user. Admin-created accounts are pre-confirmed so the user can sign
 * in via a magic/invite link immediately (no separate email-confirmation step).
 * Supplying a password is the test-account path (so tests can `signInWithPassword`).
 */
export async function createUser(
  env: GoTrueAdminEnv,
  email: string,
  opts?: { password?: string },
): Promise<GoTrueUser> {
  const cfg = resolveConfig(env);
  const validEmail = requireEmail(email);
  const body: Record<string, unknown> = {
    email: validEmail,
    email_confirm: true,
  };
  if (opts?.password !== undefined) {
    body.password = requireNonEmpty(opts.password, "password");
  }
  const user = await adminFetch(cfg, "POST", "/admin/users", body);
  return user as GoTrueUser;
}

/** Delete a GoTrue user by id. */
export async function deleteUser(env: GoTrueAdminEnv, id: string): Promise<void> {
  const cfg = resolveConfig(env);
  const validId = requireNonEmpty(id, "user id");
  await adminFetch(cfg, "DELETE", `/admin/users/${encodeURIComponent(validId)}`);
}

/**
 * Update a GoTrue user. Currently used only for ban/unban: pass a `ban_duration`
 * string (a GoTrue duration like "876000h", or "none" to unban). A far-future
 * ban is GoTrue's idiom for "disable indefinitely".
 */
export async function updateUser(
  env: GoTrueAdminEnv,
  id: string,
  patch: { ban_duration?: string },
): Promise<GoTrueUser> {
  const cfg = resolveConfig(env);
  const validId = requireNonEmpty(id, "user id");
  const body: Record<string, unknown> = {};
  if (patch.ban_duration !== undefined) {
    body.ban_duration = requireNonEmpty(patch.ban_duration, "ban_duration");
  }
  const user = await adminFetch(cfg, "PUT", `/admin/users/${encodeURIComponent(validId)}`, body);
  return user as GoTrueUser;
}

// NOTE: there is deliberately NO signOutUser here. GoTrue's admin REST API has
// no per-user sign-out endpoint (POST /admin/users/:id/logout does not exist —
// it 404s on hosted Supabase). Session revocation is done at the DB level via
// content_tool.revoke_auth_sessions() — see routes/admin.ts revoke-sessions.

/** Far-future ban duration = "disabled indefinitely" (GoTrue idiom). ~100yr. */
export const DISABLE_BAN_DURATION = "876000h";
/** Unban sentinel. */
export const ENABLE_BAN_DURATION = "none";

/**
 * List GoTrue users (one page). The admin list is paginated; callers that need
 * the full set page until the array is short. Returns the page's users array.
 */
export async function listUsers(
  env: GoTrueAdminEnv,
  opts?: { page?: number; perPage?: number },
): Promise<GoTrueUser[]> {
  const cfg = resolveConfig(env);
  const page = opts?.page ?? 1;
  const perPage = opts?.perPage ?? 1000;
  const result = await adminFetch(cfg, "GET", `/admin/users?page=${page}&per_page=${perPage}`);
  if (
    result !== null &&
    typeof result === "object" &&
    Array.isArray((result as { users?: unknown }).users)
  ) {
    return (result as { users: GoTrueUser[] }).users;
  }
  return [];
}

/** Hard page cap for `findUserByEmail` (20 × 1000 users) — runaway-loop guard. */
const FIND_USER_MAX_PAGES = 20;

/**
 * Find a GoTrue user by email (case-insensitive). GoTrue's admin list has no
 * reliable server-side email filter across versions, so this pages through
 * `/admin/users` and matches client-side. Returns null when not found.
 *
 * Needed because Google OAuth auto-creates a GoTrue identity for anyone who
 * signs in — so "create" flows must be able to ADOPT an existing identity
 * (e.g. a previously deleted user who signed in again) instead of failing on
 * GoTrue's "already registered" rejection.
 */
export async function findUserByEmail(
  env: GoTrueAdminEnv,
  email: string,
): Promise<GoTrueUser | null> {
  const validEmail = requireEmail(email).toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= FIND_USER_MAX_PAGES; page++) {
    const users = await listUsers(env, { page, perPage });
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === validEmail);
    if (hit !== undefined) return hit;
    if (users.length < perPage) break; // short page = last page
  }
  return null;
}
