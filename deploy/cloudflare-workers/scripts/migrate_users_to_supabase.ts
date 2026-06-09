// WS4 — User migration: better-auth `content_tool."user"` → Supabase Auth (GoTrue)
// + `content_tool.app_user`.
//
// MANUAL-RUN ONLY. This is not part of the Worker runtime or any build step; it
// is referenced from the Supabase Auth cutover runbook and run once, by hand, by
// an operator during cutover. It lives under `scripts/` (outside the Worker
// tsconfig `include` of `src/**`) so it never enters the Worker bundle/typecheck.
//
// What it does, per legacy user:
//   1. Read all rows from content_tool."user" (id, email, name, role) over a
//      direct Postgres connection (POSTGRES_URL), reusing the workers package's
//      `postgres` dependency.
//   2. Create a GoTrue auth user (no password, email_confirm=true) via the admin
//      REST API; if the GoTrue user already exists, look it up by email instead.
//   3. Upsert a content_tool.app_user row keyed by the GoTrue user uuid, with the
//      role mapped admin→admin / editor→reviewer / viewer→author (a stored 4-role
//      value maps to itself; anything unrecognised → viewer), display_name = name,
//      status = 'active'.
//   4. Idempotent: an existing app_user row for the email is left untouched.
//
// PII hygiene (Bowtie data rules): the summary reports COUNTS, never user lists.
// An email may appear only in a per-error line so the operator can act on it; no
// other PII is printed, and the service_role key is NEVER printed or logged.
//
// Usage (dry-run is the DEFAULT — pass --commit to actually write):
//   SUPABASE_URL=https://<proj>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service_role_key> \
//   POSTGRES_URL=postgres://content_tool_app:...@host:5432/postgres \
//   npx tsx deploy/cloudflare-workers/scripts/migrate_users_to_supabase.ts --dry-run
//
//   # to commit:
//   ... npx tsx deploy/cloudflare-workers/scripts/migrate_users_to_supabase.ts --commit

import postgres from "postgres";

// --- Minimal ambient declarations -------------------------------------------
// This script runs under Node (tsx), not the Worker runtime, and the workers
// package intentionally has no `@types/node`. Declare just what we touch so the
// file is self-contained and type-checks without pulling in extra deps.
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit: (code: number) => never;
};

// --- Role mapping (WS0 contract) ---------------------------------------------
// admin→admin, editor→reviewer (legacy "editor" tier became "reviewer"),
// viewer→author (legacy "viewer" became the new "author" tier). A value that is
// already one of the new 4-role names maps to itself. Unknown → viewer.
type AppRole = "admin" | "reviewer" | "author" | "viewer";

function mapRole(legacy: string | null | undefined): AppRole {
  switch ((legacy ?? "").trim().toLowerCase()) {
    case "admin":
      return "admin";
    case "editor":
    case "reviewer":
      return "reviewer";
    case "viewer":
    case "author":
      return "author";
    default:
      return "viewer";
  }
}

// --- Env loading (fail safe) --------------------------------------------------
interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  postgresUrl: string;
  dryRun: boolean;
}

function loadConfig(): Config {
  const missing: string[] = [];
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const postgresUrl = process.env.POSTGRES_URL?.trim();
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!postgresUrl) missing.push("POSTGRES_URL");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(", ")}. ` +
        "See the usage header of this script.",
    );
  }

  // --commit opts into writes; otherwise dry-run (the safe default). --dry-run is
  // accepted for explicitness but is the default regardless.
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const dryRunFlag = args.includes("--dry-run");
  if (commit && dryRunFlag) {
    throw new Error("Pass either --commit or --dry-run, not both.");
  }

  return {
    // Non-null assertions are safe: `missing` guard above already threw if unset.
    supabaseUrl: supabaseUrl!.replace(/\/$/, ""),
    serviceRoleKey: serviceRoleKey!,
    postgresUrl: postgresUrl!,
    dryRun: !commit,
  };
}

// --- GoTrue admin REST client -------------------------------------------------
// Self-contained `fetch` calls against the GoTrue admin API. We deliberately do
// NOT import @supabase/supabase-js or any other agent's files.

interface GoTrueUser {
  id: string;
  email?: string;
}

interface GoTrueListResponse {
  users?: GoTrueUser[];
}

function adminHeaders(cfg: Config): Record<string, string> {
  return {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

// Look up an existing GoTrue user by email. Returns the user or null.
async function findGoTrueUserByEmail(
  cfg: Config,
  email: string,
): Promise<GoTrueUser | null> {
  const url = `${cfg.supabaseUrl}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`;
  const res = await fetch(url, { method: "GET", headers: adminHeaders(cfg) });
  if (!res.ok) {
    throw new Error(`GoTrue list users failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as GoTrueListResponse;
  const users = body.users ?? [];
  // GoTrue's filter is a fuzzy match; require an exact, case-insensitive hit.
  const lower = email.toLowerCase();
  return users.find((u) => (u.email ?? "").toLowerCase() === lower) ?? null;
}

// Create a GoTrue user with no password, email pre-confirmed. If the user
// already exists, fall back to looking them up by email (idempotent).
async function createOrFindGoTrueUser(
  cfg: Config,
  email: string,
): Promise<{ user: GoTrueUser; created: boolean }> {
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(cfg),
    body: JSON.stringify({ email, email_confirm: true }),
  });

  if (res.ok) {
    const user = (await res.json()) as GoTrueUser;
    if (!user.id) {
      throw new Error("GoTrue createUser returned no id");
    }
    return { user, created: true };
  }

  // 409 / 422 (user already registered) → idempotent path: find by email.
  if (res.status === 409 || res.status === 422 || res.status === 400) {
    const existing = await findGoTrueUserByEmail(cfg, email);
    if (existing?.id) {
      return { user: existing, created: false };
    }
  }

  throw new Error(`GoTrue createUser failed (HTTP ${res.status})`);
}

// --- DB types -----------------------------------------------------------------
interface LegacyUser {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
}

// --- Summary ------------------------------------------------------------------
interface Summary {
  total: number;
  authCreated: number; // GoTrue users newly created
  authReused: number; // GoTrue users that already existed
  appUserUpserted: number; // app_user rows written
  appUserSkipped: number; // app_user rows already present (idempotent no-op)
  byRole: Record<AppRole, number>;
  errors: Array<{ email: string; message: string }>;
}

function newSummary(): Summary {
  return {
    total: 0,
    authCreated: 0,
    authReused: 0,
    appUserUpserted: 0,
    appUserSkipped: 0,
    byRole: { admin: 0, reviewer: 0, author: 0, viewer: 0 },
    errors: [],
  };
}

function printSummary(summary: Summary, dryRun: boolean): void {
  const mode = dryRun ? "DRY-RUN (no writes performed)" : "COMMIT";
  console.log("");
  console.log(`=== User migration summary — ${mode} ===`);
  console.log(`  legacy users read:        ${summary.total}`);
  console.log(`  GoTrue users created:     ${summary.authCreated}`);
  console.log(`  GoTrue users reused:      ${summary.authReused}`);
  console.log(`  app_user rows upserted:   ${summary.appUserUpserted}`);
  console.log(`  app_user rows skipped:    ${summary.appUserSkipped}`);
  console.log("  mapped by role:");
  console.log(`    admin:    ${summary.byRole.admin}`);
  console.log(`    reviewer: ${summary.byRole.reviewer}`);
  console.log(`    author:   ${summary.byRole.author}`);
  console.log(`    viewer:   ${summary.byRole.viewer}`);
  console.log(`  errors:                   ${summary.errors.length}`);
  for (const e of summary.errors) {
    // Email is the minimum needed for the operator to act; no other PII.
    console.log(`    - ${e.email}: ${e.message}`);
  }
  console.log("==========================================");
}

// --- Core migration -----------------------------------------------------------
async function migrate(): Promise<number> {
  const cfg = loadConfig();
  const summary = newSummary();

  const sql = postgres(cfg.postgresUrl, { max: 2, fetch_types: false });
  try {
    const rows = (await sql<LegacyUser[]>`
      SELECT id, email, name, role
      FROM content_tool."user"
      ORDER BY email
    `) as unknown as LegacyUser[];
    summary.total = rows.length;

    for (const row of rows) {
      const email = (row.email ?? "").trim();
      const role = mapRole(row.role);
      summary.byRole[role] += 1;

      if (!email) {
        summary.errors.push({ email: "(blank)", message: "legacy user has no email" });
        continue;
      }

      try {
        // Idempotency check: app_user already present for this email?
        const existingAppUser = (await sql<Array<{ id: string }>>`
          SELECT id FROM content_tool.app_user WHERE email = ${email} LIMIT 1
        `) as unknown as Array<{ id: string }>;
        if (existingAppUser.length > 0) {
          summary.appUserSkipped += 1;
          continue;
        }

        if (cfg.dryRun) {
          // Report intended action without touching GoTrue or the DB.
          console.log(
            `WOULD migrate ${email} → role=${role} (GoTrue createUser + app_user upsert)`,
          );
          summary.appUserUpserted += 1;
          // We cannot know created-vs-reused without a write; count as created
          // for the dry-run projection.
          summary.authCreated += 1;
          continue;
        }

        const { user, created } = await createOrFindGoTrueUser(cfg, email);
        if (created) summary.authCreated += 1;
        else summary.authReused += 1;

        // Upsert app_user keyed by the GoTrue uuid. ON CONFLICT on the unique
        // email keeps this idempotent even under a concurrent re-run.
        await sql`
          INSERT INTO content_tool.app_user (id, email, display_name, role, status)
          VALUES (${user.id}, ${email}, ${row.name ?? null}, ${role}, 'active')
          ON CONFLICT (email) DO NOTHING
        `;
        summary.appUserUpserted += 1;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "unexpected error";
        summary.errors.push({ email, message });
      }
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }

  printSummary(summary, cfg.dryRun);
  return summary.errors.length > 0 ? 1 : 0;
}

migrate()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`migration aborted: ${message}`);
    process.exit(1);
  });
