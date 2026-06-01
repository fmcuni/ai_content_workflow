/**
 * Unit tests for the pure segregation-of-duties (4-eyes) helper.
 */
import { describe, expect, it } from "vitest";

import { evaluateSod } from "./sod";

describe("evaluateSod", () => {
  it("allows when author differs from actor", () => {
    expect(
      evaluateSod({ createdBy: "alice@b.com", actor: "bob@b.com", actorRole: "reviewer" }),
    ).toEqual({ allowed: true, override: false });
  });

  it("forbids self-approval (author == actor, no override)", () => {
    expect(
      evaluateSod({ createdBy: "alice@b.com", actor: "alice@b.com", actorRole: "reviewer" }),
    ).toEqual({ allowed: false });
  });

  it("matches author/actor case-insensitively", () => {
    expect(
      evaluateSod({ createdBy: "Alice@B.com", actor: "alice@b.COM", actorRole: "reviewer" }),
    ).toEqual({ allowed: false });
  });

  it("allows break-glass when admin supplies a non-empty override_reason", () => {
    expect(
      evaluateSod({
        createdBy: "alice@b.com",
        actor: "alice@b.com",
        actorRole: "admin",
        overrideReason: "sole on-call editor, urgent fix",
      }),
    ).toEqual({ allowed: true, override: true, reason: "sole on-call editor, urgent fix" });
  });

  it("does NOT break-glass for a non-admin even with a reason", () => {
    expect(
      evaluateSod({
        createdBy: "alice@b.com",
        actor: "alice@b.com",
        actorRole: "reviewer",
        overrideReason: "please let me",
      }),
    ).toEqual({ allowed: false });
  });

  it("does NOT break-glass for an admin with a blank reason", () => {
    expect(
      evaluateSod({
        createdBy: "alice@b.com",
        actor: "alice@b.com",
        actorRole: "admin",
        overrideReason: "   ",
      }),
    ).toEqual({ allowed: false });
  });

  it("does not trip the bar when the author is unknown/blank", () => {
    expect(
      evaluateSod({ createdBy: "", actor: "alice@b.com", actorRole: "viewer" }),
    ).toEqual({ allowed: true, override: false });
    expect(
      evaluateSod({ createdBy: null, actor: "alice@b.com", actorRole: "viewer" }),
    ).toEqual({ allowed: true, override: false });
  });

  it("does not trip the bar when the actor is unknown/blank", () => {
    expect(
      evaluateSod({ createdBy: "alice@b.com", actor: null, actorRole: "viewer" }),
    ).toEqual({ allowed: true, override: false });
  });
});
