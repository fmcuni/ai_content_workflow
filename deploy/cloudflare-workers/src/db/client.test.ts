import { afterEach, describe, expect, it, vi } from "vitest";

// Capture the options postgres() is constructed with, without opening a socket.
const postgresMock = vi.fn((_url: string, _opts: unknown) => ({ end: vi.fn() }));
vi.mock("postgres", () => ({ default: (url: string, opts: unknown) => postgresMock(url, opts) }));

import { getSql } from "./client";
import type { Env } from "../index";

const fakeEnv = {
  HYPERDRIVE: { connectionString: "postgres://user:pw@host:5432/db" },
} as unknown as Env;

describe("getSql", () => {
  afterEach(() => postgresMock.mockClear());

  it("sets a statement_timeout so a hung query can never block indefinitely", () => {
    // Act
    getSql(fakeEnv);

    // Assert
    const opts = postgresMock.mock.calls[0]?.[1] as unknown as {
      connection?: { statement_timeout?: number };
    };
    const timeout = Number(opts.connection?.statement_timeout);
    expect(Number.isFinite(timeout)).toBe(true);
    expect(timeout).toBeGreaterThan(0);
    // Must abort well before Cloudflare's 10-minute default Workflow step timeout.
    expect(timeout).toBeLessThan(600_000);
  });

  it("keeps the proven Hyperdrive pool options (max + fetch_types)", () => {
    getSql(fakeEnv);
    const opts = postgresMock.mock.calls[0]?.[1] as unknown as {
      max?: number;
      fetch_types?: boolean;
    };
    expect(opts.max).toBe(5);
    expect(opts.fetch_types).toBe(false);
  });
});
