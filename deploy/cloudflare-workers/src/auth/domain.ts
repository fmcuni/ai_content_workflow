import type { Env } from "../index";

// Default allowlist — Bowtie Hong Kong staff. Overridable via the
// ALLOWED_EMAIL_DOMAINS var so the list can change without a code deploy
// (e.g. add `bowtie.com.sg`).
const DEFAULT_ALLOWED_DOMAINS = "bowtie.com.hk";

/** Parse the configured allowlist into a normalized, lowercase domain list. */
export function allowedEmailDomains(env: Env): string[] {
  return (env.ALLOWED_EMAIL_DOMAINS ?? DEFAULT_ALLOWED_DOMAINS)
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `email`'s domain is in the configured allowlist. */
export function isAllowedEmailDomain(email: string, env: Env): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return allowedEmailDomains(env).includes(domain);
}
