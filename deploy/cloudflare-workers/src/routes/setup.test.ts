import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupRouter } from "./setup";

// Minimal env satisfying the bindings the /setup/status handler reads.
function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    POSTGRES_URL: "postgresql://user:secret@db.internal.example.com:5432/app?sslmode=require",
    GEMINI_API_KEY: "test-key",
    WP_USERNAME: "wp",
    WP_APP_PASSWORD: "wp-pass",
    ...overrides,
  };
}

async function getStatus(env: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await setupRouter.request("/status", {}, env);
  const body = await res.json();
  return { status: res.status, body };
}

describe("GET /setup/status", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("returns the generic status fields the frontend SetupGate needs", async () => {
    const { status, body } = await getStatus(makeEnv());
    expect(status).toBe(200);
    expect(body.configured).toBe(true);
    expect(Array.isArray(body.missing)).toBe(true);
    expect(body.wp_configured).toBe(true);
  });

  it("does NOT leak DB connection internals (host/port/sslmode/connection string)", async () => {
    const { body } = await getStatus(makeEnv());
    const serialized = JSON.stringify(body).toLowerCase();

    // No infra detail must appear in the client-facing response.
    expect(serialized).not.toContain("host");
    expect(serialized).not.toContain("port");
    expect(serialized).not.toContain("sslmode");
    expect(serialized).not.toContain("db.internal.example.com");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("secret");

    // Only the allowed keys are present.
    expect(Object.keys(body).sort()).toEqual(["configured", "missing", "wp_configured"]);
  });

  it("logs connection host/port/sslmode server-side (never credentials/full URL)", async () => {
    await getStatus(makeEnv());
    expect(logSpy).toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(logged).toContain("db.internal.example.com");
    expect(logged).toContain("5432");
    expect(logged).toContain("require");
    // Credentials and the full connection string must never be logged.
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("postgresql://");
  });

  it("reports missing required fields generically", async () => {
    const { body } = await getStatus(
      makeEnv({ POSTGRES_URL: undefined, GEMINI_API_KEY: undefined }),
    );
    expect(body.configured).toBe(false);
    expect(body.missing).toContain("postgres_url");
    expect(body.missing).toContain("gemini_api_key");
  });
});
