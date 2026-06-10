import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { blockKnownCrawlers, isKnownCrawler, KNOWN_CRAWLER_UA_SNIPPETS, ROBOTS_TXT } from "./bot-guard";

const GOOGLEBOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// The Playwright e2e + claude-debug harnesses run headless Chromium — they
// MUST NOT be classified as crawlers.
const HEADLESS_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36";

// Mirrors the index.ts ordering: robots.txt BEFORE the guard, routes after.
function makeApp(): Hono {
  const app = new Hono();
  app.get("/robots.txt", (c) => c.text(ROBOTS_TXT));
  app.use("*", blockKnownCrawlers);
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}

describe("isKnownCrawler", () => {
  it("matches search, AI, and scanner user agents", () => {
    expect(isKnownCrawler(GOOGLEBOT_UA)).toBe(true);
    expect(isKnownCrawler(GPTBOT_UA)).toBe(true);
    expect(isKnownCrawler("ClaudeBot/1.0; +claudebot@anthropic.com")).toBe(true);
    expect(isKnownCrawler("Mozilla/5.0 (compatible; CensysInspect/1.1)")).toBe(true);
    expect(isKnownCrawler("masscan/1.3")).toBe(true);
  });

  it("matching is case-insensitive", () => {
    expect(isKnownCrawler("GOOGLEBOT")).toBe(true);
    expect(isKnownCrawler("ahrefsbot/7.0")).toBe(true);
  });

  it("never matches browsers, headless test harnesses, or programmatic clients", () => {
    expect(isKnownCrawler(CHROME_UA)).toBe(false);
    expect(isKnownCrawler(HEADLESS_CHROME_UA)).toBe(false);
    expect(isKnownCrawler("node")).toBe(false);
    expect(isKnownCrawler("curl/8.6.0")).toBe(false);
    expect(isKnownCrawler(undefined)).toBe(false);
    expect(isKnownCrawler("")).toBe(false);
  });

  it("the snippet list stays lowercase (substring match contract)", () => {
    for (const snippet of KNOWN_CRAWLER_UA_SNIPPETS) {
      expect(snippet).toBe(snippet.toLowerCase());
    }
  });
});

describe("blockKnownCrawlers middleware", () => {
  it("403s a known crawler before any route runs", async () => {
    const res = await makeApp().request("/health", {
      headers: { "user-agent": GOOGLEBOT_UA },
    });
    expect(res.status).toBe(403);
    await expect(res.text()).resolves.toBe("Forbidden");
  });

  it("passes browser and UA-less requests through", async () => {
    const app = makeApp();
    const browser = await app.request("/health", { headers: { "user-agent": CHROME_UA } });
    expect(browser.status).toBe(200);
    const bare = await app.request("/health");
    expect(bare.status).toBe(200);
  });

  it("robots.txt stays fetchable by crawlers and disallows everything", async () => {
    const res = await makeApp().request("/robots.txt", {
      headers: { "user-agent": GPTBOT_UA },
    });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("User-agent: *\nDisallow: /\n");
  });
});
