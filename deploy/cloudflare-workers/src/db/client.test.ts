import { afterEach, describe, expect, it, vi } from "vitest";

// Capture the options postgres() is constructed with, without opening a socket.
const postgresMock = vi.fn((_url: string, _opts: unknown) => ({ end: vi.fn() }));
vi.mock("postgres", () => ({ default: (url: string, opts: unknown) => postgresMock(url, opts) }));

import { getSql, isConnectionError, resetSqlCache, runWithSqlContext } from "./client";
import type { Env } from "../index";

const fakeEnv = {
  HYPERDRIVE: { connectionString: "postgres://user:pw@host:5432/db" },
} as unknown as Env;

describe("getSql", () => {
  afterEach(() => {
    postgresMock.mockClear();
  });

  it("sets a statement_timeout so a hung query can never block indefinitely", () => {
    // Act
    runWithSqlContext(() => getSql(fakeEnv));

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

  it("keeps the proven Hyperdrive pool options (max + fetch_types) plus socket-lifetime bounds", () => {
    runWithSqlContext(() => getSql(fakeEnv));
    const opts = postgresMock.mock.calls[0]?.[1] as unknown as {
      max?: number;
      fetch_types?: boolean;
      idle_timeout?: number;
      max_lifetime?: number;
    };
    expect(opts.max).toBe(5);
    expect(opts.fetch_types).toBe(false);
    // Request-scoped clients are never explicitly `.end()`ed, so they must
    // self-close instead of lingering until isolate eviction.
    expect(opts.idle_timeout).toBeGreaterThan(0);
    expect(opts.max_lifetime).toBeGreaterThan(0);
  });

  it("memoizes the SAME instance for repeat calls within one runWithSqlContext", () => {
    runWithSqlContext(() => {
      const first = getSql(fakeEnv);
      const second = getSql(fakeEnv);
      expect(second).toBe(first);
    });
    expect(postgresMock).toHaveBeenCalledTimes(1);
  });

  it("builds a DIFFERENT instance across two separate runWithSqlContext calls", () => {
    const first = runWithSqlContext(() => getSql(fakeEnv));
    const second = runWithSqlContext(() => getSql(fakeEnv));

    expect(second).not.toBe(first);
    expect(postgresMock).toHaveBeenCalledTimes(2);
  });

  it("builds a FRESH instance per call outside any runWithSqlContext (Workflows, DO alarms)", () => {
    const first = getSql(fakeEnv);
    const second = getSql(fakeEnv);

    expect(second).not.toBe(first);
    expect(postgresMock).toHaveBeenCalledTimes(2);
  });

  it("returns a DIFFERENT instance after resetSqlCache() evicts it within the same context", () => {
    runWithSqlContext(() => {
      const first = getSql(fakeEnv);
      resetSqlCache(fakeEnv.HYPERDRIVE.connectionString);
      const second = getSql(fakeEnv);
      expect(second).not.toBe(first);
    });
    expect(postgresMock).toHaveBeenCalledTimes(2);
  });

  it("caches per connection string — a different Hyperdrive binding builds its own client", () => {
    const otherEnv = {
      HYPERDRIVE: { connectionString: "postgres://user:pw@other-host:5432/db" },
    } as unknown as Env;

    runWithSqlContext(() => {
      const first = getSql(fakeEnv);
      const second = getSql(otherEnv);
      expect(second).not.toBe(first);
    });
    expect(postgresMock).toHaveBeenCalledTimes(2);
  });
});

describe("isConnectionError", () => {
  it("matches the Workers cross-request fault", () => {
    expect(isConnectionError(new Error("Cannot perform I/O on behalf of a different request"))).toBe(
      true,
    );
  });

  it("matches postgres.js connection error codes (errors.js `connection()`)", () => {
    const closed = Object.assign(new Error("write CONNECTION_CLOSED host:5432"), {
      code: "CONNECTION_CLOSED",
    });
    const destroyed = Object.assign(new Error("write CONNECTION_DESTROYED host:5432"), {
      code: "CONNECTION_DESTROYED",
    });
    const ended = Object.assign(new Error("write CONNECTION_ENDED host:5432"), {
      code: "CONNECTION_ENDED",
    });
    const timeout = Object.assign(new Error("write CONNECT_TIMEOUT host:5432"), {
      code: "CONNECT_TIMEOUT",
    });
    expect(isConnectionError(closed)).toBe(true);
    expect(isConnectionError(destroyed)).toBe(true);
    expect(isConnectionError(ended)).toBe(true);
    expect(isConnectionError(timeout)).toBe(true);
  });

  it("matches generic Node socket errors by code", () => {
    const econnreset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isConnectionError(econnreset)).toBe(true);
  });

  it("does NOT flag a routine query error (e.g. a constraint violation)", () => {
    const constraintViolation = Object.assign(new Error('duplicate key value violates unique constraint "runs_pkey"'), {
      code: "23505",
    });
    expect(isConnectionError(constraintViolation)).toBe(false);
  });

  it("does NOT flag a non-Error thrown value", () => {
    expect(isConnectionError("plain string failure")).toBe(false);
  });
});
