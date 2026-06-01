import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { Env } from "../index";
import { allowedEmailDomains, isAllowedEmailDomain } from "./domain";
import { resetPasswordHtml, sendEmail, verifyEmailHtml } from "./email";

// Minimum password length — exceeds the better-auth default (8) for an internal
// tool handling editorial content.
const MIN_PASSWORD_LENGTH = 10;

/**
 * Build a per-request better-auth instance bound to this Worker's env.
 *
 * The auth tables live in the `content_tool` schema; the connection's
 * search_path is set at the DB-role level (Hyperdrive ignores per-connection
 * startup params) so better-auth's unqualified table names resolve there.
 * Columns use better-auth's native camelCase names (see the
 * *_better_auth_camel_columns.sql migration) — better-auth 1.6.13 has no
 * `casing` option, so its default camelCase schema is authoritative.
 *
 * baseURL is the FRONTEND origin so verification/reset links point at the web
 * app and flow back through its same-origin `/api/auth` proxy rewrite.
 *
 * Returns `{ auth, sql }`; the caller MUST close `sql`
 * (`waitUntil(sql.end())`) after the response is sent.
 */
export function getAuth(env: Env) {
  // Connect through Hyperdrive (same as the REST routes) — a direct connection
  // blows the free-plan subrequest cap. We use node-postgres (`pg`), Cloudflare's
  // officially-supported Hyperdrive driver: the `kysely-postgres-js` dialect
  // HANGS over Hyperdrive (proven via /auth-diag — raw queries work, that dialect
  // stalls). better-auth's tables live in the content_tool schema; the
  // search_path is set at the DB-role level (see the *_auth_search_path.sql
  // migration), not as a per-connection startup param (Hyperdrive ignores those).
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });

  // Email verification is ON by default. Set the EMAIL_VERIFICATION var to "off"
  // to temporarily allow sign-in without verification (e.g. while the Resend
  // sending domain is being DNS-verified). When off, we also skip the on-signup
  // send so sign-up can't stall on email.
  const verificationEnabled = env.EMAIL_VERIFICATION !== "off";

  const auth = betterAuth({
    secret: env.AUTH_SECRET,
    baseURL: env.FRONTEND_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: env.FRONTEND_ORIGIN ? [env.FRONTEND_ORIGIN] : [],
    database: {
      dialect: new PostgresDialect({ pool }),
      type: "postgres",
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: verificationEnabled,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(env, {
          to: user.email,
          subject: "Reset your Bowtie Content Desk password",
          html: resetPasswordHtml(url),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: verificationEnabled,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(env, {
          to: user.email,
          subject: "Verify your Bowtie Content Desk account",
          html: verifyEmailHtml(url),
        });
      },
    },
    hooks: {
      // Enforce the email-domain allowlist server-side, regardless of client.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
        if (!isAllowedEmailDomain(email, env)) {
          throw new APIError("BAD_REQUEST", {
            message: `Sign-up is restricted to ${allowedEmailDomains(env).join(", ")} email addresses.`,
          });
        }
      }),
    },
  });

  // `sql` is the pg Pool; callers close it via `waitUntil(sql.end())`.
  return { auth, sql: pool };
}
