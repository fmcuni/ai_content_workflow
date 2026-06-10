// Mint a Claude debug session for the DEV web app (headless login helper).
//
//   node scripts/claude-debug/login.mjs
//
// Signs in via the Supabase password grant using CLAUDE_DEBUG_EMAIL /
// CLAUDE_DEBUG_PASSWORD from the gitignored .env.dev.local, then writes a
// Playwright storageState file (scripts/claude-debug/.out/state.json,
// gitignored) holding the session cookie exactly as the browser app would
// write it: chunked `bowtie-sb-auth.0..n` cookies, 3000 raw chars per chunk,
// per-chunk encodeURIComponent — mirroring web/lib/supabase-client.ts. The
// middleware's presence gate reads chunk `.0` (web/middleware.ts).
//
// Uses the real @supabase/supabase-js (from web/node_modules) with a memory
// storage capture, mirroring web/tests/e2e/support/supabase-auth.ts, so the
// persisted session shape is byte-faithful to what the app expects.
//
// Prints only statuses and file paths — never tokens or passwords.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  COOKIE_CHUNK_SIZE,
  DEV_WEB_HOST,
  loadDevEnv,
  OUT_DIR,
  reportEnvPresence,
  STATE_FILE,
  SUPABASE_COOKIE_NAME,
  REPO_ROOT,
} from "./dev-env.mjs";

const requireWeb = createRequire(path.join(REPO_ROOT, "web", "package.json"));
const { createClient } = requireWeb("@supabase/supabase-js");

function fail(msg) {
  process.stderr.write(`login: ${msg}\n`);
  process.exit(1);
}

const cfg = loadDevEnv();
const presence = reportEnvPresence(cfg);
if (!presence.anonKey) fail("no anon key in .env.dev.local");
if (!presence.claudeDebugCreds) {
  fail("CLAUDE_DEBUG_EMAIL/CLAUDE_DEBUG_PASSWORD missing — run provision.mjs first");
}

// Memory storage capture: supabase-js persists the session under storageKey,
// which is exactly the raw value the app's cookie storage would chunk.
const captured = {};
const memoryStorage = {
  getItem: (k) => captured[k] ?? null,
  setItem: (k, v) => {
    captured[k] = v;
  },
  removeItem: (k) => {
    delete captured[k];
  },
};

const client = createClient(cfg.supabaseUrl, cfg.anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storage: memoryStorage,
    storageKey: SUPABASE_COOKIE_NAME,
  },
});

const { error } = await client.auth.signInWithPassword({
  email: cfg.claudeEmail,
  password: cfg.claudePassword,
});
if (error) fail(`password grant failed (${error.status ?? "?"}): ${error.message}`);

const raw = captured[SUPABASE_COOKIE_NAME];
if (!raw) fail("sign-in succeeded but no session was persisted to storage");

// Chunk + encode exactly like writeChunkedCookie in web/lib/supabase-client.ts.
const chunks = [];
for (let i = 0; i < raw.length; i += COOKIE_CHUNK_SIZE) {
  chunks.push(raw.slice(i, i + COOKIE_CHUNK_SIZE));
}
const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
const cookies = chunks.map((chunk, i) => ({
  name: `${SUPABASE_COOKIE_NAME}.${i}`,
  value: encodeURIComponent(chunk),
  domain: DEV_WEB_HOST,
  path: "/",
  expires,
  httpOnly: false,
  secure: true,
  sameSite: "Lax",
}));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify({ cookies, origins: [] }, null, 2));
process.stdout.write(
  `login ok: ${chunks.length} cookie chunk(s) → ${STATE_FILE} (expires ${new Date(expires * 1000).toISOString()})\n`,
);
