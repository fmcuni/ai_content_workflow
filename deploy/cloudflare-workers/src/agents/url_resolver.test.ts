import { describe, expect, it } from "vitest";

import { apexDomain } from "./url_resolver";

describe("apexDomain", () => {
  it("keeps three labels for a .org.hk compound suffix", () => {
    // Arrange / Act
    const apex = apexDomain("https://www.ia.org.hk/en/page");

    // Assert
    expect(apex).toBe("ia.org.hk");
  });

  it("keeps three labels for a .gov.hk compound suffix with subdomain", () => {
    expect(apexDomain("http://www.hkma.gov.hk")).toBe("hkma.gov.hk");
  });

  it("keeps two labels for a single-level suffix (.int)", () => {
    expect(apexDomain("https://who.int/data")).toBe("who.int");
  });

  it("keeps two labels for a common .com host", () => {
    expect(apexDomain("https://www.reddit.com/r/hongkong")).toBe("reddit.com");
  });

  it("returns a bare host unchanged (lowercased, no suffix logic needed)", () => {
    expect(apexDomain("localhost")).toBe("localhost");
  });

  it("returns null when no host can be parsed", () => {
    expect(apexDomain("")).toBeNull();
  });
});
