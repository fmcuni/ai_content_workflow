#!/usr/bin/env node
// Drift-guard for the backend Worker's wrangler secrets. Compares the LIVE
// secret-name set (from `wrangler secret list`) against the committed manifest
// scripts/worker-secrets.json. NAMES ONLY — secret VALUES are never read,
// printed, or logged.
//
//   node scripts/check-secrets.mjs            # check prod (bowtie-content-tool-poc)
//   node scripts/check-secrets.mjs --env dev  # check dev  (bowtie-content-tool-poc-dev)
//   node scripts/check-secrets.mjs --strict   # also FAIL on unexpected/stale names
//
// Exit non-zero when a REQUIRED secret is missing (real runtime breakage), or
// on any unexpected name under --strict. Unexpected names (e.g. the retired
// RESEND_API_KEY) warn by default — that is exactly the class this catches.
//
// Needs wrangler auth: locally `wrangler login`, in CI the CLOUDFLARE_API_TOKEN
// + CLOUDFLARE_ACCOUNT_ID env vars (same as the deploy jobs).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = join(REPO_ROOT, "deploy", "cloudflare-workers");

const args = process.argv.slice(2);
const isDev = args.includes("--env") && args[args.indexOf("--env") + 1] === "dev";
const strict = args.includes("--strict");
const envLabel = isDev ? "dev (bowtie-content-tool-poc-dev)" : "prod (bowtie-content-tool-poc)";

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "worker-secrets.json"), "utf8"));
const required = new Set(manifest.backend.required);
const allowed = new Set([...manifest.backend.required, ...manifest.backend.optional]);

// `wrangler secret list` prints a JSON array of { name, type }. Names only.
const wranglerArgs = ["wrangler", "secret", "list", ...(isDev ? ["--env", "dev"] : [])];
const res = spawnSync("npx", wranglerArgs, { cwd: WORKERS_DIR, encoding: "utf8" });
if (res.status !== 0) {
  console.error(`wrangler secret list failed for ${envLabel}:\n${res.stderr || res.stdout}`);
  process.exit(2);
}

let live;
try {
  // Tolerate any non-JSON preamble wrangler may print before the array.
  const json = res.stdout.slice(res.stdout.indexOf("["), res.stdout.lastIndexOf("]") + 1);
  live = new Set(JSON.parse(json).map((s) => s.name));
} catch (e) {
  console.error(`could not parse wrangler output: ${e.message}`);
  process.exit(2);
}

const missing = [...required].filter((n) => !live.has(n)).sort();
const unexpected = [...live].filter((n) => !allowed.has(n)).sort();

console.log(`Secret drift check — ${envLabel}`);
console.log(`  live: ${live.size}  required: ${required.size}  allowed: ${allowed.size}`);
if (missing.length) console.error(`  ✗ MISSING required: ${missing.join(", ")}`);
if (unexpected.length) console.warn(`  ⚠ unexpected/stale: ${unexpected.join(", ")}`);
if (!missing.length && !unexpected.length) console.log("  ✓ no drift");

const fail = missing.length > 0 || (strict && unexpected.length > 0);
process.exit(fail ? 1 : 0);
