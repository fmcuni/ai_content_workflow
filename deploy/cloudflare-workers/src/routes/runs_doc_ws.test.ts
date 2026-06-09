/**
 * GET /runs/:id/doc — the realtime-collab WebSocket-upgrade route.
 *
 * Mounts the real `requireAuth` middleware in front of the real `runsRouter`
 * (mirroring how index.ts composes them) so the ticket gate, the server-side
 * Origin check, the 426 upgrade guard, and the forward to the RUN_DOC Durable
 * Object are all exercised end-to-end against a mocked DO stub.
 *
 * A real WS upgrade cannot run in the node vitest env, so the happy path
 * asserts the route resolved the DO by run id and forwarded the raw request to
 * the stub, returning the stub's 101 — which is sufficient to cover the route
 * logic without pulling in @cloudflare/vitest-pool-workers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// runsRouter transitively imports these; stub them so the module loads under node.
vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(() => []),
}));
vi.mock("../gemini/do_client", () => ({ DoGeminiClient: class {} }));

import { Hono } from "hono";
import runsRouter from "./runs";
import { requireAuth, type AuthVars } from "../auth/middleware";
import { mintTicket } from "../auth/ticket";

const AUTH_SECRET = "test-secret-for-doc-ws";
const FRONTEND_ORIGIN = "https://app.example.test";
const RUN_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "user-123";

interface MockStub {
  fetch: ReturnType<typeof vi.fn>;
}

interface MockRunDoc {
  idFromName: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  __stub: MockStub;
}

// A real WS handshake response carries status 101; the node `undici` Response
// constructor rejects 101, so the stub returns a minimal Response-like object
// the route forwards verbatim (Hono returns the handler's value untouched).
function makeWsResponse(): Response {
  return { status: 101, headers: new Headers(), body: null } as unknown as Response;
}

function makeRunDoc(stubResponse: Response): MockRunDoc {
  const stub: MockStub = { fetch: vi.fn(async () => stubResponse) };
  const idFromName = vi.fn((name: string) => ({ __id: name }));
  const get = vi.fn(() => stub);
  return { idFromName, get, __stub: stub };
}

function makeEnv(runDoc: MockRunDoc, frontendOrigin: string | undefined): Record<string, unknown> {
  return {
    AUTH_DISABLED: "false",
    AUTH_SECRET,
    FRONTEND_ORIGIN: frontendOrigin,
    RUN_DOC: runDoc,
  };
}

type AuthApp = Hono<{ Variables: AuthVars }>;

function app(): AuthApp {
  const a = new Hono<{ Variables: AuthVars }>();
  a.use("*", requireAuth);
  // Mount at /runs to mirror index.ts (app.route("/runs", runsRouter)) so the
  // path requireAuth sees is the real /runs/:id/doc.
  a.route("/runs", runsRouter);
  return a;
}

async function req(
  env: Record<string, unknown>,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return app().request(
    path,
    { method: "GET", headers },
    env,
    executionCtx as unknown as ExecutionContext,
  );
}

let runDoc: MockRunDoc;
let env: Record<string, unknown>;

beforeEach(() => {
  runDoc = makeRunDoc(makeWsResponse());
  env = makeEnv(runDoc, FRONTEND_ORIGIN);
});

describe("GET /runs/:id/doc — auth + upgrade", () => {
  it("returns 401 when the ?ticket is missing (requireAuth)", async () => {
    const res = await req(env, `/runs/${RUN_ID}/doc`, {
      upgrade: "websocket",
      origin: FRONTEND_ORIGIN,
    });
    expect(res.status).toBe(401);
    expect(runDoc.idFromName).not.toHaveBeenCalled();
  });

  it("returns 426 with a valid ticket but no Upgrade header", async () => {
    const ticket = await mintTicket(env as never, USER_ID);
    const res = await req(env, `/runs/${RUN_ID}/doc?ticket=${ticket}`, {
      origin: FRONTEND_ORIGIN,
    });
    expect(res.status).toBe(426);
    expect(runDoc.idFromName).not.toHaveBeenCalled();
  });

  it("returns 403 for a disallowed Origin and never fetches the DO", async () => {
    const ticket = await mintTicket(env as never, USER_ID);
    const res = await req(env, `/runs/${RUN_ID}/doc?ticket=${ticket}`, {
      upgrade: "websocket",
      origin: "https://evil.example.test",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("forbidden");
    expect(runDoc.idFromName).not.toHaveBeenCalled();
    expect(runDoc.__stub.fetch).not.toHaveBeenCalled();
  });

  it("forwards the upgrade to RUN_DOC and returns 101 on the happy path", async () => {
    const ticket = await mintTicket(env as never, USER_ID);
    const res = await req(env, `/runs/${RUN_ID}/doc?ticket=${ticket}`, {
      upgrade: "websocket",
      origin: FRONTEND_ORIGIN,
    });
    expect(res.status).toBe(101);
    expect(runDoc.idFromName).toHaveBeenCalledWith(RUN_ID);
    expect(runDoc.get).toHaveBeenCalledTimes(1);
    expect(runDoc.__stub.fetch).toHaveBeenCalledTimes(1);
  });

  it("skips the Origin check when FRONTEND_ORIGIN is unset (local dev)", async () => {
    env = makeEnv(runDoc, undefined);
    const ticket = await mintTicket(env as never, USER_ID);
    const res = await req(env, `/runs/${RUN_ID}/doc?ticket=${ticket}`, {
      upgrade: "websocket",
      origin: "https://anything.example.test",
    });
    expect(res.status).toBe(101);
    expect(runDoc.idFromName).toHaveBeenCalledWith(RUN_ID);
  });
});
