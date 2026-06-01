import { describe, expect, it } from "vitest";

import { resolvePublishStatus } from "./publish_status";

describe("resolvePublishStatus", () => {
  it("honors an explicit 'publish' selection (regression: create no longer forced to draft)", () => {
    expect(resolvePublishStatus("publish")).toBe("publish");
  });

  it("honors 'future' (scheduled) selections", () => {
    expect(resolvePublishStatus("future")).toBe("future");
  });

  it("passes 'draft' through unchanged", () => {
    expect(resolvePublishStatus("draft")).toBe("draft");
  });

  it("defaults to 'draft' when nothing was selected (null)", () => {
    expect(resolvePublishStatus(null)).toBe("draft");
  });

  it("defaults to 'draft' when undefined", () => {
    expect(resolvePublishStatus(undefined)).toBe("draft");
  });
});
