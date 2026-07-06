import { describe, expect, it } from "vitest";

import { buildMeta } from "./client";

describe("buildMeta", () => {
  it("emits _yoast_wpseo_metadesc only for yoast", () => {
    expect(buildMeta("desc", null, "yoast")).toEqual({ _yoast_wpseo_metadesc: "desc" });
  });

  it("emits rank_math_description only for rankmath", () => {
    expect(buildMeta("desc", null, "rankmath")).toEqual({ rank_math_description: "desc" });
  });

  it("omits any SEO description key when plugin is null", () => {
    expect(buildMeta("desc", null, null)).toEqual({});
  });

  it("always ships the schema graph out-of-band as _bowtie_schema_jsonld", () => {
    const meta = buildMeta(null, [{ "@type": "FAQPage" }], null);
    expect(meta._bowtie_schema_jsonld).toBe(JSON.stringify([{ "@type": "FAQPage" }]));
    expect(meta._yoast_wpseo_metadesc).toBeUndefined();
  });
});
