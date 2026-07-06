import { describe, expect, it } from "vitest";

import {
  applySecurityHeaders,
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
} from "./security-headers";

describe("security-headers", () => {
  it("includes all five required hardening headers", () => {
    // Arrange
    const keys = SECURITY_HEADERS.map((h) => h.key);

    // Assert
    expect(keys).toContain("Content-Security-Policy");
    expect(keys).toContain("X-Frame-Options");
    expect(keys).toContain("X-Content-Type-Options");
    expect(keys).toContain("Referrer-Policy");
    expect(keys).toContain("X-Robots-Tag");
  });

  it("sets the exact hardening header values", () => {
    const byKey = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["X-Robots-Tag"]).toBe("noindex, nofollow, noarchive, nosnippet");
  });

  it("CSP locks the default-src to self and forbids unsafe-eval", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  });

  it("CSP connect-src allows self, supabase, and the workers.dev SSE + WS origins", () => {
    expect(CONTENT_SECURITY_POLICY).toMatch(/connect-src[^;]*'self'/);
    expect(CONTENT_SECURITY_POLICY).toContain("https://*.supabase.co");
    expect(CONTENT_SECURITY_POLICY).toContain("https://*.fmc.workers.dev");
    expect(CONTENT_SECURITY_POLICY).toContain("wss://*.fmc.workers.dev");
    expect(CONTENT_SECURITY_POLICY).toContain("https://*.franco-ma.workers.dev");
    expect(CONTENT_SECURITY_POLICY).toContain("wss://*.franco-ma.workers.dev");
  });

  it("CSP allows inline scripts (documented hydration fallback) and inline styles", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-inline'");
    expect(CONTENT_SECURITY_POLICY).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  it("CSP allows images from self, data URIs, and https", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' data: https:");
  });

  it("applySecurityHeaders writes every header onto a Headers instance", () => {
    // Arrange
    const headers = new Headers();

    // Act
    applySecurityHeaders(headers);

    // Assert
    expect(headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive, nosnippet");
  });
});
