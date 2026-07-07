/**
 * Concurrency + identity hardening tests for the HITL resume routes.
 *
 * These exercise the real Hono handlers (POST /:id/resume, POST /:id/hitl-2,
 * POST /) against a STATEFUL in-memory fake `sql` injected via `vi.mock` on
 * `../db/client`. The fake evaluates the conditional-UPDATE WHERE guards the
 * same way Postgres would (matching on the fake row's status / hitl_2_iteration),
 * so it covers:
 *
 *   FIX 1 — HITL_2 request_changes cap is enforced atomically (a request that
 *           arrives once the counter already hit the cap gets count=0 → 409).
 *   FIX 2/3 — HITL_1 + HITL_2 decisions are rejected (409) unless the run is
 *           PAUSED at the matching gate status; the winning request is the one
 *           that flips the status, single-flighting the sendEvent.
 *   FIX 4 — `approved_by` (HITL_2) and `created_by` (POST /) are derived from the
 *           authenticated session, NOT a spoofed payload `editor_email`.
 *
 * The fake `sql` reconstructs the full statement text from the tagged-template
 * strings (splicing in nested `sql\`...\`` fragments) so it can branch on
 * SELECT vs UPDATE and on which WHERE guards are present. It is intentionally
 * minimal — only the statements these handlers issue are modelled.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory run row + fake sql. Declared before vi.mock so the hoisted factory
// can close over them.
// ---------------------------------------------------------------------------

interface FakeRow {
  run_id: string;
  status: string;
  hitl_2_iteration: number;
  hitl_1_decision: string | null;
  approved_by: string | null;
  created_by: string | null;
}

const state: { row: FakeRow | null; sendEvents: unknown[]; creates: unknown[] } = {
  row: null,
  sendEvents: [],
  creates: [],
};

interface Fragment {
  __frag: true;
  text: string;
}

function isFragment(v: unknown): v is Fragment {
  return typeof v === "object" && v !== null && "__frag" in v;
}

/** Reconstruct statement text, splicing nested fragments; ignore value binds. */
function renderText(strings: TemplateStringsArray, values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isFragment(v)) {
      out += v.text;
    }
    out += strings[i + 1] ?? "";
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The fake `sql`: callable as a tagged template, with `.json()` for jsonb binds.
 * Returns Fragment objects for nested templates and `{ count }` for UPDATEs /
 * row arrays for SELECTs, evaluating the WHERE guards against `state.row`.
 */
function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = renderText(strings, values);
    const lower = text.toLowerCase();
    const row = state.row;

    // Nested fragment (no leading verb): used for capGuard / newIteration.
    if (!/^\s*(select|update|insert|delete)\b/.test(lower)) {
      return { __frag: true, text } as Fragment;
    }

    if (lower.startsWith("select")) {
      if (row === null) return [];
      // The approve-path pre-flight guard reads publish metadata; this harness
      // doesn't model it, so return an empty result (meta absent → guard skips,
      // exercising the concurrency/identity paths these tests target).
      if (lower.includes("select persona, wp_publish_status")) return [];
      // Return the row (only the selected columns matter to callers, but the
      // full object is harmless).
      return [row];
    }

    if (lower.startsWith("insert")) {
      // POST / create-run INSERT … RETURNING run_id, created_at, article_id.
      // The created_by value is the FIRST interpolated bind after run_id.
      // We can't see binds in `text`, so capture created_by from values: the
      // create handler passes runId then createdBy as the first two binds.
      const binds = values.filter((v) => !isFragment(v));
      const createdBy = typeof binds[1] === "string" ? binds[1] : null;
      state.row = {
        run_id: "run-new",
        status: "pending",
        hitl_2_iteration: 0,
        hitl_1_decision: null,
        approved_by: null,
        created_by: createdBy,
      };
      return [{ run_id: "run-new", created_at: "2026-06-01 00:00:00+00", article_id: null }];
    }

    if (lower.startsWith("update") && row !== null) {
      // Compensating rollback UPDATEs issued from the sendEvent-failure catch
      // blocks (no status guard at all — just `WHERE run_id = ...`). Detected
      // by the literal `= null` columns the handlers write; the iteration
      // revert value is a bind (not inlined into `text`), so pull it from
      // `values`.
      if (lower.includes("hitl_1_decision = null") && lower.includes("hitl_1_notes = null")) {
        row.hitl_1_decision = null;
        return { count: 1 };
      }
      if (lower.includes("hitl_2_decision = null") && lower.includes("approved_at = null")) {
        const binds = values.filter((v) => !isFragment(v));
        const priorIteration = binds.find((v): v is number => typeof v === "number");
        if (priorIteration !== undefined) row.hitl_2_iteration = priorIteration;
        row.approved_by = null;
        return { count: 1 };
      }

      // Evaluate the conditional WHERE guards present in the statement text.
      // Value binds (runId, gate-status literal) are NOT echoed into `text`, so
      // match structurally on the SET column + a `WHERE ... status =` guard.
      const hasStatusGuard = /where[\s\S]*status\s*=/.test(lower);
      const requiresHitl1Gate = hasStatusGuard && lower.includes("hitl_1_decision");
      const requiresHitl2Gate = hasStatusGuard && lower.includes("hitl_2_decision");
      const requiresCap = lower.includes("hitl_2_iteration <");

      // Gate-status guard: the handlers compare against the literal gate status.
      // request: status must equal 'hitl_1' (resume) or 'hitl_2' (hitl-2).
      let gateOk = true;
      if (requiresHitl1Gate) gateOk = row.status === "hitl_1";
      else if (requiresHitl2Gate) gateOk = row.status === "hitl_2";

      let capOk = true;
      if (requiresCap) capOk = row.hitl_2_iteration < 3;

      if (!gateOk || !capOk) {
        return { count: 0 };
      }

      // Apply the mutation effects the assertions care about.
      if (requiresHitl1Gate) {
        row.hitl_1_decision = "approve";
      }
      if (requiresHitl2Gate) {
        if (requiresCap) {
          row.hitl_2_iteration += 1;
        }
        // approved_by is the bind that is NOT the gate-status literal; capture
        // the first string bind that looks like an identity (contains @ or is
        // non-empty and not a status). Simplest: scan binds for the email-ish.
        const binds = values.filter((v) => !isFragment(v));
        const approver = binds.find(
          (v): v is string =>
            typeof v === "string" && (v.includes("@") || v.startsWith("user_")),
        );
        if (approver !== undefined) row.approved_by = approver;
        row.status = "publishing"; // moved off the gate
      }
      return { count: 1 };
    }

    // Any other UPDATE (e.g. renders) — no-op success.
    return { count: 0 };
  };
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({
    __frag: true,
    text: JSON.stringify(v),
  });
  return sql;
}

vi.mock("../db/client", () => ({
  withDb: async (
    _env: unknown,
    _ctx: unknown,
    fn: (sql: unknown) => Promise<unknown>,
  ) => fn(makeFakeSql()),
}));

// Stub the heavy WP / Gemini deps the module imports at load time (unused by
// these routes, but the module graph must resolve).
vi.mock("../gemini/do_client", () => ({ DoGeminiClient: class {} }));

import runsRouter from "./runs";

// ---------------------------------------------------------------------------
// Minimal env: a fake PRODUCTION workflow binding recording sendEvent calls.
// ---------------------------------------------------------------------------

function makeEnv(authEmail: string | null): Record<string, unknown> {
  const instance = {
    sendEvent: async (e: unknown) => {
      state.sendEvents.push(e);
    },
    restart: async () => undefined,
  };
  return {
    AUTH_DISABLED: authEmail === null ? "true" : "false",
    __authEmail: authEmail,
    PRODUCTION: { get: async () => instance, create: async () => undefined },
    FRONTEND_ORIGIN: "https://example.test",
    // RBAC: these legacy concurrency/identity tests predate role gating and
    // assert on the create/resume/hitl-2 flows, not on authorization. Bootstrap
    // the session email to `admin` so the new requireRole gates always pass;
    // the dedicated RBAC tests live in runs_rbac.test.ts.
    BOOTSTRAP_ADMIN_EMAILS: authEmail ?? "",
  };
}

// runsRouter doesn't run requireAuth itself, so set userEmail via a wrapper.
import { Hono } from "hono";
import type { AuthVars } from "../auth/middleware";

type AuthApp = Hono<{ Variables: AuthVars }>;

function appWith(authEmail: string | null): AuthApp {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    if (authEmail !== null) c.set("userEmail", authEmail);
    await next();
  });
  app.route("/", runsRouter);
  return app;
}

// Same as appWith, but PRODUCTION.get() throws — simulating a workflow instance
// that doesn't exist on this deployment (e.g. the run was created on a
// different Cloudflare account sharing the same Postgres DB). The rescue
// fallback then re-creates the instance HERE; `createError` breaks that too:
// "fail" exercises the un-claim + 409 compensation path, "exists" simulates a
// concurrent sibling having already adopted the run (treated as success).
function appWithMissingInstance(
  authEmail: string | null,
  createError?: "fail" | "exists",
): AuthApp {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    if (authEmail !== null) c.set("userEmail", authEmail);
    c.env = {
      ...(c.env as Record<string, unknown>),
      PRODUCTION: {
        get: async () => {
          throw new Error("instance.not_found");
        },
        create: async (opts: unknown) => {
          if (createError === "fail") throw new Error("workflows.api_error");
          if (createError === "exists")
            throw new Error(`instance.already_exists: instance with id already exists`);
          state.creates.push(opts);
        },
      },
    };
    await next();
  });
  app.route("/", runsRouter);
  return app;
}

async function req(
  app: AuthApp,
  method: string,
  path: string,
  body: unknown,
  authEmail: string | null,
): Promise<Response> {
  const executionCtx = {
    waitUntil: (_p: Promise<unknown>) => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return app.request(
    path,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    makeEnv(authEmail),
    executionCtx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  state.row = null;
  state.sendEvents = [];
  state.creates = [];
});

// ---------------------------------------------------------------------------
// FIX 4 — session-derived identity
// ---------------------------------------------------------------------------

describe("POST /:id/hitl-2 — approved_by identity (FIX 4)", () => {
  it("records the SESSION email as approved_by, ignoring a spoofed payload editor_email", async () => {
    state.row = {
      run_id: "r1",
      status: "hitl_2",
      hitl_2_iteration: 0,
      hitl_1_decision: "approve",
      approved_by: null,
      created_by: null,
    };
    const app = appWith("real-reviewer@bowtie.com.hk");
    const res = await req(
      app,
      "POST",
      "/r1/hitl-2",
      { decision: "approve", editor_email: "attacker@evil.example" },
      "real-reviewer@bowtie.com.hk",
    );
    expect(res.status).toBe(200);
    expect(state.row.approved_by).toBe("real-reviewer@bowtie.com.hk");
    expect(state.row.approved_by).not.toBe("attacker@evil.example");
  });
});

describe("POST / — created_by identity (FIX 4)", () => {
  it("records the SESSION email as created_by, ignoring a spoofed payload editor_email", async () => {
    const app = appWith("creator@bowtie.com.hk");
    const res = await req(
      app,
      "POST",
      "/",
      {
        start_mode: "create",
        topic: "t",
        editor_email: "attacker@evil.example",
      },
      "creator@bowtie.com.hk",
    );
    expect(res.status).toBe(200);
    expect(state.row?.created_by).toBe("creator@bowtie.com.hk");
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — HITL_2 request_changes cap is atomic
// ---------------------------------------------------------------------------

describe("POST /:id/hitl-2 — request_changes cap (FIX 1)", () => {
  it("returns 409 when a concurrent request_changes arrives at the cap", async () => {
    // Simulate the row already at the cap (a concurrent request incremented it).
    state.row = {
      run_id: "r1",
      status: "hitl_2",
      hitl_2_iteration: 3,
      hitl_1_decision: "approve",
      approved_by: null,
      created_by: null,
    };
    const app = appWith("rev@bowtie.com.hk");
    const res = await req(
      app,
      "POST",
      "/r1/hitl-2",
      { decision: "request_changes" },
      "rev@bowtie.com.hk",
    );
    expect(res.status).toBe(409);
    expect(state.sendEvents).toHaveLength(0);
  });

  it("allows request_changes below the cap and increments atomically", async () => {
    state.row = {
      run_id: "r1",
      status: "hitl_2",
      hitl_2_iteration: 1,
      hitl_1_decision: "approve",
      approved_by: null,
      created_by: null,
    };
    const app = appWith("rev@bowtie.com.hk");
    const res = await req(
      app,
      "POST",
      "/r1/hitl-2",
      { decision: "request_changes" },
      "rev@bowtie.com.hk",
    );
    expect(res.status).toBe(200);
    expect(state.row.hitl_2_iteration).toBe(2);
    expect(state.sendEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FIX 2/3 — gate-status guards single-flight the decision
// ---------------------------------------------------------------------------

describe("POST /:id/hitl-2 — gate-status guard (FIX 2/3)", () => {
  it("returns 409 when the run is NOT paused at the HITL_2 gate", async () => {
    state.row = {
      run_id: "r1",
      status: "publishing", // already moved off the gate
      hitl_2_iteration: 0,
      hitl_1_decision: "approve",
      approved_by: null,
      created_by: null,
    };
    const app = appWith("rev@bowtie.com.hk");
    const res = await req(
      app,
      "POST",
      "/r1/hitl-2",
      { decision: "approve" },
      "rev@bowtie.com.hk",
    );
    expect(res.status).toBe(409);
    expect(state.sendEvents).toHaveLength(0);
  });
});

describe("POST /:id/resume — HITL_1 gate-status guard (FIX 2/3)", () => {
  it("returns 409 when the run is NOT paused at the HITL_1 gate", async () => {
    state.row = {
      run_id: "r1",
      status: "production", // past HITL_1
      hitl_2_iteration: 0,
      hitl_1_decision: "approve",
      approved_by: null,
      created_by: null,
    };
    const app = appWith("rev@bowtie.com.hk");
    const res = await req(
      app,
      "POST",
      "/r1/resume",
      { decision: "approve" },
      "rev@bowtie.com.hk",
    );
    expect(res.status).toBe(409);
    expect(state.sendEvents).toHaveLength(0);
  });

  it("accepts a HITL_1 decision when paused at the gate and sends the event once", async () => {
    state.row = {
      run_id: "r1",
      status: "hitl_1",
      hitl_2_iteration: 0,
      hitl_1_decision: null,
      approved_by: null,
      created_by: null,
    };
    const app = appWith("rev@bowtie.com.hk");
    const res = await req(
      app,
      "POST",
      "/r1/resume",
      { decision: "approve" },
      "rev@bowtie.com.hk",
    );
    expect(res.status).toBe(200);
    expect(state.row.hitl_1_decision).toBe("approve"); // claimed + recorded
    expect(state.sendEvents).toHaveLength(1);
  });

  it("returns 404 when the run does not exist", async () => {
    state.row = null;
    const app = appWith("rev@bowtie.com.hk");
    const res = await req(app, "POST", "/missing/resume", { decision: "approve" }, "rev@bowtie.com.hk");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Missing workflow instance (e.g. run belongs to a different Cloudflare
// deployment sharing the same Postgres DB) — PRODUCTION.get() throws.
// ---------------------------------------------------------------------------

describe("POST /:id/resume — missing workflow instance", () => {
  it("rescues the run onto this deployment (create with the injected decision) instead of 409", async () => {
    state.row = {
      run_id: "r1",
      status: "hitl_1",
      hitl_2_iteration: 0,
      hitl_1_decision: null,
      approved_by: null,
      created_by: null,
    };
    const app = appWithMissingInstance("rev@bowtie.com.hk");
    const res = await req(app, "POST", "/r1/resume", { decision: "approve" }, "rev@bowtie.com.hk");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; rescued?: boolean };
    expect(payload.rescued).toBe(true);
    expect(state.sendEvents).toHaveLength(0);
    expect(state.creates).toHaveLength(1);
    expect(state.creates[0]).toMatchObject({
      id: "r1",
      params: {
        runId: "r1",
        rescue: { gate: "hitl_1", payload: { decision: "approve" } },
      },
    });
    // The claim STANDS — the adopted instance consumes the persisted decision.
    expect(state.row.hitl_1_decision).toBe("approve");
    expect(state.row.status).toBe("hitl_1");
  });

  it("returns 409 and un-claims the gate when the rescue create also fails", async () => {
    state.row = {
      run_id: "r1",
      status: "hitl_1",
      hitl_2_iteration: 0,
      hitl_1_decision: null,
      approved_by: null,
      created_by: null,
    };
    const app = appWithMissingInstance("rev@bowtie.com.hk", "fail");
    const res = await req(app, "POST", "/r1/resume", { decision: "approve" }, "rev@bowtie.com.hk");
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { detail: string };
    expect(payload.detail).toContain("workflow instance for this run was not found");
    expect(payload.detail).toContain("instance.not_found");
    expect(state.sendEvents).toHaveLength(0);
    expect(state.creates).toHaveLength(0);
    // Un-claimed: hitl_1_decision reverted to null, status untouched (still at
    // the gate) — a retry against a healthy deployment can succeed cleanly.
    expect(state.row.hitl_1_decision).toBeNull();
    expect(state.row.status).toBe("hitl_1");
  });
});

describe("POST /:id/hitl-2 — missing workflow instance", () => {
  it("rescues the run with the claimed decision + prior iteration instead of 409", async () => {
    state.row = {
      run_id: "r1",
      status: "hitl_2",
      hitl_2_iteration: 1,
      hitl_1_decision: "approve",
      approved_by: null,
      created_by: null,
    };
    const app = appWithMissingInstance("rev@bowtie.com.hk");
    const res = await req(
      app,
      "POST",
      "/r1/hitl-2",
      { decision: "request_changes" },
      "rev@bowtie.com.hk",
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; rescued?: boolean };
    expect(payload.rescued).toBe(true);
    expect(state.sendEvents).toHaveLength(0);
    expect(state.creates).toHaveLength(1);
    // iteration = the PRE-claim value: it seeds the adopted workflow's local
    // HITL_2 round counter exactly where the original instance was parked.
    expect(state.creates[0]).toMatchObject({
      id: "r1",
      params: {
        runId: "r1",
        rescue: { gate: "hitl_2", iteration: 1, payload: { decision: "request_changes" } },
      },
    });
    // The claim STANDS (incremented iteration is consumed by the new instance).
    expect(state.row.hitl_2_iteration).toBe(2);
  });

  it("rescues an APPROVE with the unincremented iteration and keeps approved_by claimed", async () => {
    state.row = {
      run_id: "r1",
      status: "hitl_2",
      hitl_2_iteration: 1,
      hitl_1_decision: "approve",
      approved_by: null,
      created_by: null,
    };
    const app = appWithMissingInstance("rev@bowtie.com.hk");
    const res = await req(app, "POST", "/r1/hitl-2", { decision: "approve" }, "rev@bowtie.com.hk");
    expect(res.status).toBe(200);
    expect((await res.json()) as { rescued?: boolean }).toMatchObject({ rescued: true });
    expect(state.creates[0]).toMatchObject({
      id: "r1",
      params: {
        runId: "r1",
        // approve does NOT increment: iteration is the parked round as-is.
        rescue: { gate: "hitl_2", iteration: 1, payload: { decision: "approve" } },
      },
    });
    // The claim stands — the adopted instance publishes and the compliance log
    // must see the real approver, not "unknown".
    expect(state.row.approved_by).toBe("rev@bowtie.com.hk");
    expect(state.row.hitl_2_iteration).toBe(1);
  });

  it("treats an already-adopted run (duplicate-id create) as success — no rollback", async () => {
    state.row = {
      run_id: "r1",
      status: "hitl_2",
      hitl_2_iteration: 0,
      hitl_1_decision: "approve",
      approved_by: null,
      created_by: null,
    };
    const app = appWithMissingInstance("rev@bowtie.com.hk", "exists");
    const res = await req(app, "POST", "/r1/hitl-2", { decision: "approve" }, "rev@bowtie.com.hk");
    expect(res.status).toBe(200);
    // A concurrent sibling created the instance; its workflow consumes THIS
    // claim, so approved_by must survive.
    expect(state.row.approved_by).toBe("rev@bowtie.com.hk");
  });

  it("returns 409 and reverts the claimed decision + iteration when the rescue create also fails", async () => {
    state.row = {
      run_id: "r1",
      status: "hitl_2",
      hitl_2_iteration: 1,
      hitl_1_decision: "approve",
      approved_by: null,
      created_by: null,
    };
    const app = appWithMissingInstance("rev@bowtie.com.hk", "fail");
    const res = await req(
      app,
      "POST",
      "/r1/hitl-2",
      { decision: "request_changes" },
      "rev@bowtie.com.hk",
    );
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { detail: string };
    expect(payload.detail).toContain("workflow instance for this run was not found");
    expect(state.sendEvents).toHaveLength(0);
    // Un-claimed: iteration reverted to its pre-claim value (1, not 2) so a
    // retry doesn't double-count against the request_changes cap, and
    // approved_by stays clear.
    expect(state.row.hitl_2_iteration).toBe(1);
    expect(state.row.approved_by).toBeNull();
  });
});
