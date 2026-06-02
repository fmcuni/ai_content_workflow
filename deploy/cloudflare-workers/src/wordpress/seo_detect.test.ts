import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMeta, detectSeoPlugin } from "./client";
import type { Env } from "../index";

const ENV = {
  WP_BASE_URL: "https://wp.example.com",
} as unknown as Env;

/** Shape of an OPTIONS /wp/v2/posts response: registered REST meta lives
 * under schema.properties.meta.properties. */
function optionsResponse(...metaKeys: string[]): Response {
  const properties = Object.fromEntries(metaKeys.map((k) => [k, { type: "string" }]));
  return new Response(
    JSON.stringify({ schema: { properties: { meta: { properties } } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectSeoPlugin (exact-key requirement)", () => {
  it("detects yoast when _yoast_wpseo_metadesc is registered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        optionsResponse("_yoast_wpseo_metadesc", "_yoast_wpseo_title", "_yoast_wpseo_focuskw"),
      ),
    );
    expect(await detectSeoPlugin(ENV)).toBe("yoast");
  });

  it("detects rankmath when rank_math_description is registered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => optionsResponse("rank_math_description")));
    expect(await detectSeoPlugin(ENV)).toBe("rankmath");
  });

  it("returns null when no SEO meta is registered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => optionsResponse()));
    expect(await detectSeoPlugin(ENV)).toBeNull();
  });

  it("regression: yoast namespace present but _yoast_wpseo_metadesc NOT registered → null", async () => {
    // The publish-failure root cause: claiming "yoast" off the namespace prefix
    // and then sending an unregistered protected key 400s the whole publish.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => optionsResponse("_yoast_wpseo_title", "_yoast_wpseo_focuskw")),
    );
    expect(await detectSeoPlugin(ENV)).toBeNull();
  });

  it("regression: rankmath namespace present but rank_math_description NOT registered → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => optionsResponse("rank_math_title", "rank_math_focus_keyword")),
    );
    expect(await detectSeoPlugin(ENV)).toBeNull();
  });
});

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
