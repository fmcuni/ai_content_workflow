import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";

import type { Env } from "../index";
import { allowedEmailDomains, isAllowedEmailDomain } from "./domain";
import { resetPasswordHtml, sendEmail, verifyEmailHtml } from "./email";

// Minimum password length — exceeds the better-auth default (8) for an internal
// tool handling editorial content.
const MIN_PASSWORD_LENGTH = 10;

/**
 * Build a per-request better-auth instance bound to this Worker's env.
 *
 * The auth tables live in the `content_tool` schema; a dedicated postgres.js
 * client (over Hyperdrive) sets `search_path=content_tool` so better-auth's
 * unqualified table names resolve there. `casing: "snake"` keeps column names
 * snake_case to match the hand-written migration and repo convention.
 *
 * baseURL is the FRONTEND origin so verification/reset links point at the web
 * app and flow back through its same-origin `/api/auth` proxy rewrite.
 *
 * Returns `{ auth, sql }`; the caller MUST close `sql`
 * (`waitUntil(sql.end())`) after the response is sent.
 */
export function getAuth(env: Env) {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    connection: { search_path: "content_tool" },
  });

  const auth = betterAuth({
    secret: env.AUTH_SECRET,
    baseURL: env.FRONTEND_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: env.FRONTEND_ORIGIN ? [env.FRONTEND_ORIGIN] : [],
    database: {
      dialect: new PostgresJSDialect({ postgres: sql }),
      type: "postgres",
      casing: "snake",
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
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
      sendOnSignUp: true,
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

  return { auth, sql };
}
