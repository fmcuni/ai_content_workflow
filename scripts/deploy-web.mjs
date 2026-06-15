#!/usr/bin/env node
// Deploy the frontend Worker (OpenNext) with build-time NEXT_PUBLIC_* config
// drawn from a single source of truth, identically for CI and local operators.
//
//   node scripts/deploy-web.mjs prod   ->  bowtie-content-tool-web
//   node scripts/deploy-web.mjs dev    ->  bowtie-content-tool-web-dev (--env dev)
//
// WHY THIS EXISTS
// ---------------
// NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time. They
// were previously hand-typed inline on every `cf:deploy:dev`, which repeatedly
// baked the WRONG values (prod API base / wrong Supabase URL) and bounced dev
// auth. Shell-`source`ing .env.dev.local was the other trap: it also exports
// DEV_POSTGRES_URL etc. and a parse error there blanked every var.
//
// This script PARSES the committed non-secret SSOT (web/env.<env>.public) — it
// never `source`s anything — and resolves the one secret (the Supabase anon
// key) from the environment (CI: GH Actions secret) or, as a local fallback,
// by parsing the gitignored .env file. The public file is AUTHORITATIVE: it
// overrides any stray inline NEXT_PUBLIC_* in the caller's environment, so a
// mistyped shell var can no longer reach the bundle.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = join(REPO_ROOT, "web");

const ANON_KEY = "NEXT_PUBLIC_SUPABASE_ANON_KEY";

const target = process.argv[2];
if (target !== "prod" && target !== "dev") {
  console.error(`usage: node scripts/deploy-web.mjs <prod|dev>  (got: ${target ?? "nothing"})`);
  process.exit(1);
}

/** Parse a KEY=VALUE env file into an object. Ignores blanks/`#` comments,
 *  splits on the FIRST `=`, and strips one layer of surrounding quotes. */
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// 1. Public, non-secret SSOT (committed). Authoritative for NEXT_PUBLIC_* values.
const publicFile = join(WEB_DIR, `env.${target}.public`);
if (!existsSync(publicFile)) {
  console.error(`missing SSOT file: web/env.${target}.public`);
  process.exit(1);
}
const publicEnv = parseEnvFile(publicFile);

// 2. Resolve the anon key. CI passes it via the environment (GH secret). Locally
//    fall back to the gitignored .env file for the target. Never printed.
//    NOTE the local dev file stores it under DEV_SUPABASE_ANON_KEY (DEV_ prefix).
const localEnvFile = join(REPO_ROOT, target === "dev" ? ".env.dev.local" : ".env.local");
const localEnv = parseEnvFile(localEnvFile);
const anon =
  process.env[ANON_KEY] ||
  process.env[`${ANON_KEY}_${target.toUpperCase()}`] ||
  localEnv[ANON_KEY] ||
  (target === "dev" ? localEnv.DEV_SUPABASE_ANON_KEY : undefined);

if (!anon) {
  const localHint =
    target === "dev"
      ? "add DEV_SUPABASE_ANON_KEY=... to .env.dev.local"
      : "add NEXT_PUBLIC_SUPABASE_ANON_KEY=... to .env.local";
  console.error(
    `${ANON_KEY} not found.\n` +
      `  CI:    set the ${ANON_KEY}${target === "dev" ? "_DEV" : ""} GH Actions secret.\n` +
      `  local: ${localHint}.`,
  );
  process.exit(1);
}

// Public file wins over the caller's inherited env so a stray inline value can't
// be baked; the anon key is layered in last.
const buildEnv = { ...process.env, ...publicEnv, [ANON_KEY]: anon, WEB_BUILD_TARGET: "cloudflare" };

const deployArgs = ["opennextjs-cloudflare", "deploy", ...(target === "dev" ? ["--env", "dev"] : [])];

console.log(`Deploying frontend Worker [${target}]`);
for (const k of Object.keys(publicEnv)) console.log(`  ${k}=${publicEnv[k]}`);
console.log(`  ${ANON_KEY}=*** (resolved, hidden)`);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: WEB_DIR, stdio: "inherit", env: buildEnv });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("npx", ["opennextjs-cloudflare", "build"]);
run("npx", deployArgs);
