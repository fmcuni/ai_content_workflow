import { describe, expect, it } from "vitest";

import { resolveActorIdentity } from "./identity";

describe("resolveActorIdentity", () => {
  it("uses the session email when present", () => {
    expect(
      resolveActorIdentity({ userEmail: "alice@bowtie.com.hk" }, null),
    ).toBe("alice@bowtie.com.hk");
  });

  it("IGNORES a spoofed payload editor_email when a session email is present", () => {
    expect(
      resolveActorIdentity(
        { userEmail: "alice@bowtie.com.hk" },
        "attacker@evil.example",
      ),
    ).toBe("alice@bowtie.com.hk");
  });

  it("falls back to the session user id when there is no session email (SSE-ticket path)", () => {
    expect(
      resolveActorIdentity({ userId: "user_123" }, "attacker@evil.example"),
    ).toBe("user_123");
  });

  it("prefers the session email over the session user id", () => {
    expect(
      resolveActorIdentity(
        { userEmail: "alice@bowtie.com.hk", userId: "user_123" },
        null,
      ),
    ).toBe("alice@bowtie.com.hk");
  });

  it("falls back to the payload email only when no session identity exists (dev / AUTH_DISABLED)", () => {
    expect(resolveActorIdentity({}, "dev@bowtie.com.hk")).toBe(
      "dev@bowtie.com.hk",
    );
  });

  it("falls back to 'unknown' when neither a session nor a payload identity exists", () => {
    expect(resolveActorIdentity({}, null)).toBe("unknown");
    expect(resolveActorIdentity({}, undefined)).toBe("unknown");
  });

  it("treats blank/whitespace values as absent", () => {
    expect(resolveActorIdentity({ userEmail: "  " }, "fallback@bowtie.com.hk")).toBe(
      "fallback@bowtie.com.hk",
    );
    expect(resolveActorIdentity({ userEmail: "", userId: "" }, "")).toBe("unknown");
  });
});
