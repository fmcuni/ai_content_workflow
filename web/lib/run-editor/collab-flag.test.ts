import { afterEach, describe, expect, it, vi } from "vitest";

import { isCollabEnabled } from "./collab-flag";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isCollabEnabled", () => {
  it("defaults OFF when NEXT_PUBLIC_COLLAB_ENABLED is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_COLLAB_ENABLED", undefined as unknown as string);
    expect(isCollabEnabled()).toBe(false);
  });

  it("is OFF for any value other than the exact string 'true'", () => {
    vi.stubEnv("NEXT_PUBLIC_COLLAB_ENABLED", "1");
    expect(isCollabEnabled()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_COLLAB_ENABLED", "TRUE");
    expect(isCollabEnabled()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_COLLAB_ENABLED", "false");
    expect(isCollabEnabled()).toBe(false);
  });

  it("is ON only for the exact string 'true'", () => {
    vi.stubEnv("NEXT_PUBLIC_COLLAB_ENABLED", "true");
    expect(isCollabEnabled()).toBe(true);
  });
});
