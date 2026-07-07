#!/usr/bin/env node
// Post-deploy smoke check: confirm one or more URLs return HTTP 200, with
// retries. Extracted from the old deploy-workers.yml GitHub Actions workflow
// (2026-07-06 addition, after a CI-built frontend artifact deployed "green"
// while every server-rendered route hung until the CPU limit) so the same
// check can be chained onto a Cloudflare Workers Builds deploy command, e.g.:
//
//   npx wrangler deploy && node ../../scripts/smoke-check.mjs \
//     https://bowtie-content-tool-web.franco-ma.workers.dev/login
//
// Usage: node scripts/smoke-check.mjs <url> [url...]
// Exits non-zero (failing the deploy command chain) if any URL doesn't
// return 200 within RETRIES attempts.

const RETRIES = 3;
const RETRY_DELAY_MS = 10_000;
const TIMEOUT_MS = 20_000;

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: node scripts/smoke-check.mjs <url> [url...]");
  process.exit(1);
}

async function checkOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkWithRetries(url) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const status = await checkOnce(url);
    if (status === 200) {
      console.log(`${url} → 200`);
      return true;
    }
    console.log(`${url} → ${status || "no response"} (attempt ${attempt}/${RETRIES})`);
    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS);
  }
  return false;
}

const results = await Promise.all(urls.map(checkWithRetries));
const failed = urls.filter((_, i) => !results[i]);

if (failed.length) {
  console.error(`FAIL: did not return 200 — ${failed.join(", ")}`);
  process.exit(1);
}
