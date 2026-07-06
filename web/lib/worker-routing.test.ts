import { describe, expect, test } from "vitest";

import { classifyRequest, mapApiTarget, type ClassifyInput } from "./worker-routing";

const API_BASE = "https://backend.example.workers.dev";
const PRERENDERED = new Set(["/", "/login", "/signup", "/verify", "/runs", "/runs/new"]);

function baseInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    method: "GET",
    pathname: "/runs",
    userAgent: "Mozilla/5.0",
    cookieHeader: null,
    isRscRequest: false,
    prerenderedRoutes: PRERENDERED,
    apiBase: API_BASE,
    ...overrides,
  };
}

describe("classifyRequest", () => {
  test("known crawler UA gets a flat 403 before anything else", () => {
    // Arrange
    const input = baseInput({ userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "crawler-403" });
  });

  test("a /_next/static/ miss maps to a plain 404, no delegation", () => {
    // Arrange
    const input = baseInput({ pathname: "/_next/static/chunks/missing.js" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "static-miss-404" });
  });

  test("/api/* prefix proxies straight to the backend target", () => {
    // Arrange
    const input = baseInput({ pathname: "/api/runs/123/resume", method: "POST" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({
      type: "api-proxy",
      target: `${API_BASE}/runs/123/resume`,
    });
  });

  test("/api/auth-ticket is path-preserving (keeps the /api prefix)", () => {
    // Arrange & Act
    const target = mapApiTarget("/api/auth-ticket", API_BASE);

    // Assert
    expect(target).toBe(`${API_BASE}/api/auth-ticket`);
  });

  test("prerendered path with no rsc header and no session cookie redirects to login", () => {
    // Arrange
    const input = baseInput({ pathname: "/runs", cookieHeader: null });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({
      type: "redirect-login",
      location: "/login?redirect=%2Fruns",
    });
  });

  test("prerendered path with a session cookie serves the prerendered HTML", () => {
    // Arrange
    const input = baseInput({ pathname: "/runs", cookieHeader: "bowtie-sb-auth.0=abc123" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "prerender-hit", route: "/runs" });
  });

  test("public path (e.g. /login) serves the prerendered HTML with no cookie", () => {
    // Arrange
    const input = baseInput({ pathname: "/login", cookieHeader: null });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "prerender-hit", route: "/login" });
  });

  test("an rsc-header request bypasses the prerender fast path and delegates", () => {
    // Arrange
    const input = baseInput({
      pathname: "/runs",
      isRscRequest: true,
      cookieHeader: "bowtie-sb-auth.0=abc123",
    });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "delegate" });
  });

  test("a POST to a prerendered path delegates instead of serving static HTML", () => {
    // Arrange
    const input = baseInput({ pathname: "/runs", method: "POST" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "delegate" });
  });

  test("an unknown, non-prerendered path delegates to the Next handler", () => {
    // Arrange
    const input = baseInput({ pathname: "/runs/abc-123" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "delegate" });
  });

  test("a direct /__prerender/ request 404s instead of exposing the shell", () => {
    // Arrange
    const input = baseInput({ pathname: "/__prerender/runs.html" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "static-miss-404" });
  });

  test("HEAD to a prerendered public path is treated as a document request", () => {
    // Arrange
    const input = baseInput({ pathname: "/login", method: "HEAD" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "prerender-hit", route: "/login" });
  });

  test("trailing slash normalizes onto the prerendered route", () => {
    // Arrange
    const input = baseInput({ pathname: "/runs/", cookieHeader: "bowtie-sb-auth.0=abc123" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "prerender-hit", route: "/runs" });
  });

  test("an unmapped /api/* path delegates (mirrors next.config leaving it unrewritten)", () => {
    // Arrange
    const input = baseInput({ pathname: "/api/unknown-surface" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({ type: "delegate" });
  });

  test("/api/auth-ticket classifies end-to-end as a path-preserving proxy", () => {
    // Arrange
    const input = baseInput({ pathname: "/api/auth-ticket" });

    // Act
    const decision = classifyRequest(input);

    // Assert
    expect(decision).toEqual({
      type: "api-proxy",
      target: `${API_BASE}/api/auth-ticket`,
    });
  });
});
