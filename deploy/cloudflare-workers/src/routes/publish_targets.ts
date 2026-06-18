import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import {
  listPublishTargets,
  getPublishTarget,
  authRefExists,
  createPublishTarget,
  updatePublishTarget,
  setTargetArchived,
  countVoicesForTarget,
} from "../db/publish_targets";

const publishTargetsRouter = new Hono<{ Bindings: Env }>();

// auth_ref is used as an env-var prefix ({ref}_BASE_URL etc.), so it must be a
// valid shell-style identifier. Mirrors the Python _AUTH_REF_PATTERN.
const AUTH_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STATUSES = new Set(["active", "inactive"]);
const KINDS = new Set(["wordpress", "ghost"]);

// GET /publish-targets
// Bare JSON array of CMS publish targets ordered by created_at ASC. Mirrors the
// Python `GET /publish-targets`. `include_archived=true` includes archived rows.
publishTargetsRouter.get("/", async (c) => {
  const includeArchived = c.req.query("include_archived") === "true";
  const ctx = c.executionCtx as ExecutionContext;
  const targets = await withDb(c.env, ctx, (sql) =>
    listPublishTargets(sql, includeArchived),
  );
  return c.json(targets);
});

// GET /publish-targets/:id/usage — assigned voice count (warn before archive).
// 404 when the id does not resolve.
publishTargetsRouter.get("/:id/usage", async (c) => {
  const id = c.req.param("id");
  const ctx = c.executionCtx as ExecutionContext;
  const result = await withDb(c.env, ctx, async (sql) => {
    const target = await getPublishTarget(sql, id);
    if (target === null) return null;
    return countVoicesForTarget(sql, id);
  });
  if (result === null) {
    return c.json({ detail: "publish target not found" }, 404);
  }
  return c.json({ publish_target_id: id, assigned_voice_count: result });
});

// GET /publish-targets/:id/readiness — presence-only check of the target's
// credential env vars ({auth_ref}_BASE_URL/_USERNAME/_APP_PASSWORD). Booleans
// only; credential VALUES are never read into the response. Admin-gated at the
// edge (index.ts) since it reveals which secrets are provisioned.
publishTargetsRouter.get("/:id/readiness", async (c) => {
  const id = c.req.param("id");
  const ctx = c.executionCtx as ExecutionContext;
  const target = await withDb(c.env, ctx, (sql) => getPublishTarget(sql, id));
  if (target === null) {
    return c.json({ detail: "publish target not found" }, 404);
  }
  const ref = target.auth_ref;
  const env = c.env as unknown as Record<string, string | undefined>;
  // Which env vars a target needs depends on its kind (wordpress vs ghost).
  const names =
    target.kind === "ghost"
      ? [`${ref}_API_URL`, `${ref}_ADMIN_API_KEY`]
      : [`${ref}_BASE_URL`, `${ref}_USERNAME`, `${ref}_APP_PASSWORD`];
  const secrets = names.map((name) => ({ name, present: Boolean(env[name]) }));
  const ready = secrets.every((s) => s.present);
  return c.json({
    publish_target_id: id,
    auth_ref: ref,
    kind: target.kind,
    secrets,
    // Legacy WordPress-shaped fields, kept for back-compat (false for ghost).
    base_url: Boolean(env[`${ref}_BASE_URL`]),
    username: Boolean(env[`${ref}_USERNAME`]),
    app_password: Boolean(env[`${ref}_APP_PASSWORD`]),
    ready,
  });
});

// POST /publish-targets — register a new WordPress target. 422 on a malformed
// name/auth_ref/status; 409 when the auth_ref is already in use; 201 on success.
publishTargetsRouter.post("/", async (c) => {
  const body = await c.req
    .json<{ name?: unknown; auth_ref?: unknown; status?: unknown; kind?: unknown }>()
    .catch(() => null);
  if (body === null) {
    return c.json({ detail: "invalid JSON body" }, 422);
  }
  const name = typeof body.name === "string" ? body.name : "";
  const authRef = typeof body.auth_ref === "string" ? body.auth_ref : "";
  const status = typeof body.status === "string" ? body.status : "active";
  const kind = typeof body.kind === "string" ? body.kind : "wordpress";
  if (name.length < 1 || name.length > 128) {
    return c.json({ detail: "name must be 1–128 characters" }, 422);
  }
  if (authRef.length < 1 || authRef.length > 64 || !AUTH_REF_RE.test(authRef)) {
    return c.json(
      { detail: "auth_ref must match ^[A-Za-z_][A-Za-z0-9_]*$ (max 64)" },
      422,
    );
  }
  if (!STATUSES.has(status)) {
    return c.json({ detail: "status must be 'active' or 'inactive'" }, 422);
  }
  if (!KINDS.has(kind)) {
    return c.json({ detail: "kind must be 'wordpress' or 'ghost'" }, 422);
  }

  const ctx = c.executionCtx as ExecutionContext;
  const result = await withDb(c.env, ctx, async (sql) => {
    if (await authRefExists(sql, authRef)) {
      return { kind: "dup" as const };
    }
    const row = await createPublishTarget(sql, { name, auth_ref: authRef, status, kind });
    return { kind: "ok" as const, row };
  });
  if (result.kind === "dup") {
    return c.json({ detail: `auth_ref '${authRef}' is already in use` }, 409);
  }
  return c.json(result.row, 201);
});

// PATCH /publish-targets/:id — edit name / status only (auth_ref + kind immutable).
// 404 when the id does not resolve; 422 on a malformed field.
publishTargetsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{ name?: unknown; status?: unknown }>()
    .catch(() => null);
  if (body === null) {
    return c.json({ detail: "invalid JSON body" }, 422);
  }
  const patch: { name?: string; status?: string } = {};
  if (typeof body.name === "string") {
    if (body.name.length < 1 || body.name.length > 128) {
      return c.json({ detail: "name must be 1–128 characters" }, 422);
    }
    patch.name = body.name;
  }
  if (typeof body.status === "string") {
    if (!STATUSES.has(body.status)) {
      return c.json({ detail: "status must be 'active' or 'inactive'" }, 422);
    }
    patch.status = body.status;
  }

  const ctx = c.executionCtx as ExecutionContext;
  const row = await withDb(c.env, ctx, (sql) =>
    updatePublishTarget(sql, id, patch),
  );
  if (row === null) {
    return c.json({ detail: "publish target not found" }, 404);
  }
  return c.json(row);
});

// POST /publish-targets/:id/archive — soft-archive. 404 when unknown.
publishTargetsRouter.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const ctx = c.executionCtx as ExecutionContext;
  const row = await withDb(c.env, ctx, (sql) => setTargetArchived(sql, id, true));
  if (row === null) {
    return c.json({ detail: "publish target not found" }, 404);
  }
  return c.json(row);
});

// POST /publish-targets/:id/restore — un-archive. 404 when unknown.
publishTargetsRouter.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  const ctx = c.executionCtx as ExecutionContext;
  const row = await withDb(c.env, ctx, (sql) => setTargetArchived(sql, id, false));
  if (row === null) {
    return c.json({ detail: "publish target not found" }, 404);
  }
  return c.json(row);
});

export { publishTargetsRouter };
export default publishTargetsRouter;
