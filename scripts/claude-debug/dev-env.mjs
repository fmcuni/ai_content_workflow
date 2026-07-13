// Shared config loader for the Claude debug-login helpers (DEV stack ONLY).
//
// Reads the gitignored repo-root `.env.dev.local` into a plain object — values
// are NEVER printed; callers must only ever echo key NAMES / booleans. Mirrors
// the parser in web/tests/e2e/support/test-env.ts.
//
// Hard guardrail: every URL this module hands out is pinned to the DEV stack
// (Supabase ref ovxvhxwmqeccjudhyfbh, *-dev.franco-ma.workers.dev Workers). The
// loaders throw if a configured value points anywhere else, so the downstream
// scripts cannot be aimed at prod by editing the env file alone.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const ENV_FILE = path.join(REPO_ROOT, ".env.dev.local");
export const OUT_DIR = path.join(__dirname, ".out");
export const STATE_FILE = path.join(OUT_DIR, "state.json");

export const DEV_SUPABASE_REF = "ovxvhxwmqeccjudhyfbh";
export const DEV_SUPABASE_URL = `https://${DEV_SUPABASE_REF}.supabase.co`;
// 2026-07-13: dev repurposed the old prod Worker names (the `-dev` URLs were
// flagged "Suspected Phishing"; prod moved to the Enterprise account). These
// hosts are still DEV-ONLY — the pin-to-dev guard semantics are unchanged.
export const DEV_WEB_HOST = "bowtie-content-tool-web.franco-ma.workers.dev";
export const DEV_API_HOST = "bowtie-content-tool-poc.franco-ma.workers.dev";
export const DEV_WEB_URL = `https://${DEV_WEB_HOST}`;
export const DEV_API_URL = `https://${DEV_API_HOST}`;

// Mirror of SUPABASE_COOKIE_NAME in web/lib/supabase-client.ts.
export const SUPABASE_COOKIE_NAME = "bowtie-sb-auth";
// Mirror of COOKIE_CHUNK_SIZE in web/lib/supabase-client.ts (raw chars/chunk).
export const COOKIE_CHUNK_SIZE = 3000;

export const CLAUDE_DEBUG_DEFAULT_EMAIL = "content-tool-claude-debug@bowtie.com.hk";

function parseEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) {
      env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const pick = (env, keys) => keys.map((k) => env[k]).find((v) => v != null && v !== "");

/** Throw unless `value` (a URL/conn-string) references the dev Supabase ref. */
function assertDevRef(value, label) {
  if (value && !value.includes(DEV_SUPABASE_REF)) {
    throw new Error(
      `${label} in .env.dev.local does not reference the DEV Supabase project ` +
        `(${DEV_SUPABASE_REF}) — refusing to run against a non-dev target.`,
    );
  }
  return value;
}

/**
 * Load the dev credentials. Returns values for in-process use only — never
 * print anything other than `has*` booleans and the email (an identifier,
 * not a secret).
 */
export function loadDevEnv() {
  const env = parseEnvFile(ENV_FILE);
  const supabaseUrl =
    pick(env, ["DEV_SUPABASE_URL", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) ??
    DEV_SUPABASE_URL;
  const anonKey = pick(env, [
    "DEV_SUPABASE_ANON_KEY",
    "SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ]);
  const serviceRoleKey = pick(env, [
    "DEV_SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  const postgresUrl = pick(env, ["DEV_POSTGRES_URL", "POSTGRES_URL"]);

  assertDevRef(supabaseUrl, "Supabase URL");
  assertDevRef(postgresUrl, "Postgres URL");

  return {
    supabaseUrl,
    anonKey,
    serviceRoleKey,
    postgresUrl,
    claudeEmail: env.CLAUDE_DEBUG_EMAIL,
    claudePassword: env.CLAUDE_DEBUG_PASSWORD,
  };
}

/** Print which logical keys were found (names/booleans only — no values). */
export function reportEnvPresence(cfg) {
  const presence = {
    envFile: fs.existsSync(ENV_FILE),
    anonKey: Boolean(cfg.anonKey),
    serviceRoleKey: Boolean(cfg.serviceRoleKey),
    postgresUrl: Boolean(cfg.postgresUrl),
    claudeDebugCreds: Boolean(cfg.claudeEmail && cfg.claudePassword),
  };
  process.stdout.write(`env presence: ${JSON.stringify(presence)}\n`);
  return presence;
}
