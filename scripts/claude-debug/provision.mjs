// Provision the Claude debug service user on the DEV stack (idempotent).
//
//   node scripts/claude-debug/provision.mjs
//
// 1. Ensures CLAUDE_DEBUG_EMAIL / CLAUDE_DEBUG_PASSWORD exist in the gitignored
//    repo-root .env.dev.local (generates a random password on first run —
//    appended to the file, never printed).
// 2. Creates (or password-resets) the GoTrue user on the DEV Supabase project
//    via the admin REST API (service_role key; email pre-confirmed so the
//    password grant works headlessly — mirrors the content-tool-e2e pattern).
// 3. Upserts the content_tool.app_user row with role=admin via psql — the
//    invite-only authz layer (deploy/cloudflare-workers/src/auth/authz.ts)
//    returns 401 for sessions with no app_user row.
//
// dev-env.mjs hard-fails if any configured URL points at a non-dev Supabase
// ref, so this cannot provision against prod.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import {
  CLAUDE_DEBUG_DEFAULT_EMAIL,
  ENV_FILE,
  loadDevEnv,
  reportEnvPresence,
} from "./dev-env.mjs";

function fail(msg) {
  process.stderr.write(`provision: ${msg}\n`);
  process.exit(1);
}

async function gotrue(cfg, method, pathName, body) {
  const res = await fetch(`${cfg.supabaseUrl}${pathName}`, {
    method,
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // some endpoints return empty bodies; status is enough
  }
  return { status: res.status, json };
}

async function findUserByEmail(cfg, email) {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const { status, json } = await gotrue(
      cfg,
      "GET",
      `/auth/v1/admin/users?page=${page}&per_page=100`,
    );
    if (status !== 200) fail(`admin list users failed (HTTP ${status})`);
    const users = json?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === wanted);
    if (hit) return hit;
    if (users.length < 100) return null;
  }
  return null;
}

async function ensureGotrueUser(cfg, email, password) {
  const { status, json } = await gotrue(cfg, "POST", "/auth/v1/admin/users", {
    email,
    password,
    email_confirm: true,
    user_metadata: { name: "Claude Debug", purpose: "claude-code-ui-verification" },
  });
  if (status === 200 || status === 201) {
    process.stdout.write("gotrue: user created\n");
    return json.id ?? json.user?.id;
  }
  // 422 = already registered → reset the password so the stored creds always work.
  const existing = await findUserByEmail(cfg, email);
  if (!existing) {
    fail(`create returned HTTP ${status} (${json?.msg ?? json?.message ?? "?"}) and no existing user found`);
  }
  const upd = await gotrue(cfg, "PUT", `/auth/v1/admin/users/${existing.id}`, {
    password,
    email_confirm: true,
  });
  if (upd.status !== 200) fail(`password reset failed (HTTP ${upd.status})`);
  process.stdout.write("gotrue: existing user updated (password reset)\n");
  return existing.id;
}

function upsertAppUser(cfg, userId, email) {
  const sql = `
    DELETE FROM content_tool.app_user
      WHERE lower(email) = lower(:'em') AND id <> :'uid';
    INSERT INTO content_tool.app_user (id, email, display_name, role, status)
      VALUES (:'uid', :'em', 'Claude Debug', 'admin', 'active')
      ON CONFLICT (id) DO UPDATE
        SET role = 'admin', status = 'active', email = EXCLUDED.email,
            updated_at = now();
    SELECT id, role, status FROM content_tool.app_user WHERE id = :'uid';
  `;
  // SQL goes via stdin — psql only interpolates :'var' variables there, not in -c.
  const res = spawnSync(
    "psql",
    [cfg.postgresUrl, "-v", "ON_ERROR_STOP=1", "-v", `uid=${userId}`, "-v", `em=${email}`, "-X", "-q"],
    { encoding: "utf8", input: sql },
  );
  if (res.status !== 0) {
    // stderr may contain the host (dev ref only — asserted) but no password.
    fail(`app_user upsert failed: ${(res.stderr ?? "").slice(0, 300)}`);
  }
  process.stdout.write(`app_user upserted:\n${res.stdout.trim()}\n`);
}

async function verifyPasswordGrant(cfg, email, password) {
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  process.stdout.write(`password grant check: HTTP ${res.status}\n`);
  return res.status === 200;
}

const cfg = loadDevEnv();
const presence = reportEnvPresence(cfg);
if (!presence.envFile) fail(".env.dev.local not found at repo root");
if (!cfg.serviceRoleKey) fail("no service_role key found in .env.dev.local");
if (!cfg.postgresUrl) fail("no Postgres URL found in .env.dev.local");
if (!cfg.anonKey) fail("no anon key found in .env.dev.local");

const email = cfg.claudeEmail ?? CLAUDE_DEBUG_DEFAULT_EMAIL;
let password = cfg.claudePassword;
if (!password) {
  password = crypto.randomBytes(18).toString("base64url");
  fs.appendFileSync(
    ENV_FILE,
    `\n# Claude debug login (scripts/claude-debug/) — dev stack only\n` +
      `CLAUDE_DEBUG_EMAIL=${email}\nCLAUDE_DEBUG_PASSWORD=${password}\n`,
  );
  process.stdout.write("generated CLAUDE_DEBUG_* creds → appended to .env.dev.local\n");
}

const userId = await ensureGotrueUser(cfg, email, password);
if (!userId) fail("could not determine GoTrue user id");
process.stdout.write(`gotrue user id: ${userId}\n`);
upsertAppUser(cfg, userId, email);
const ok = await verifyPasswordGrant(cfg, email, password);
process.exit(ok ? 0 : 1);
