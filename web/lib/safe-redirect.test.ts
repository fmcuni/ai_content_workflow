import { afterEach, describe, expect, it, vi } from "vitest";

import { safeRedirect } from "@/lib/safe-redirect";

const ORIGIN = "https://app.example.com";

describe("safeRedirect (browser)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWindow(origin: string): void {
    vi.stubGlobal("window", { location: { origin } } as unknown as Window);
  }

  it("rejects an absolute cross-origin URL and returns the fallback", () => {
    stubWindow(ORIGIN);
    expect(safeRedirect("https://evil.com")).toBe("/");
  });

  it("rejects a protocol-relative URL (//evil.com) and returns the fallback", () => {
    stubWindow(ORIGIN);
    expect(safeRedirect("//evil.com")).toBe("/");
  });

  it("rejects a javascript: scheme and returns the fallback", () => {
    stubWindow(ORIGIN);
    expect(safeRedirect("javascript:alert(1)")).toBe("/");
  });

  it("accepts a same-origin relative path with query string", () => {
    stubWindow(ORIGIN);
    expect(safeRedirect("/runs/123?x=1")).toBe("/runs/123?x=1");
  });

  it("preserves the hash fragment on a valid relative path", () => {
    stubWindow(ORIGIN);
    expect(safeRedirect("/runs/123?x=1#section")).toBe("/runs/123?x=1#section");
  });

  it("strips the origin from a same-origin absolute URL", () => {
    stubWindow(ORIGIN);
    expect(safeRedirect(`${ORIGIN}/runs/9?y=2`)).toBe("/runs/9?y=2");
  });

  it("returns the fallback for null", () => {
    stubWindow(ORIGIN);
    expect(safeRedirect(null)).toBe("/");
  });

  it("returns the fallback for an empty string", () => {
    stubWindow(ORIGIN);
    expect(safeRedirect("")).toBe("/");
  });

  it("honors a custom fallback", () => {
    stubWindow(ORIGIN);
    expect(safeRedirect("https://evil.com", "/login")).toBe("/login");
  });
});

describe("safeRedirect (SSR / no window)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubNoWindow(): void {
    vi.stubGlobal("window", undefined);
  }

  it("accepts a leading-slash relative path without a window", () => {
    stubNoWindow();
    expect(safeRedirect("/runs/123?x=1")).toBe("/runs/123?x=1");
  });

  it("rejects a protocol-relative URL without a window", () => {
    stubNoWindow();
    expect(safeRedirect("//evil.com")).toBe("/");
  });

  it("rejects an absolute URL without a window", () => {
    stubNoWindow();
    expect(safeRedirect("https://evil.com")).toBe("/");
  });

  it("rejects a backslash-smuggled path (/\\evil.com) without a window", () => {
    stubNoWindow();
    expect(safeRedirect("/\\evil.com")).toBe("/");
  });

  it("rejects a javascript: scheme without a window", () => {
    stubNoWindow();
    expect(safeRedirect("javascript:alert(1)")).toBe("/");
  });

  it("rejects a non-slash relative value without a window", () => {
    stubNoWindow();
    expect(safeRedirect("runs/123")).toBe("/");
  });

  it("returns the fallback for null without a window", () => {
    stubNoWindow();
    expect(safeRedirect(null)).toBe("/");
  });
});
